// Copyright IBM Corp. 2017,2019. All Rights Reserved.
// Node module: @loopback/context
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import debugFactory from 'debug';
import {EventEmitter} from 'events';
import {v1 as uuidv1} from 'uuid';
import {Binding, BindingTag} from './binding';
import {
  ConfigurationResolver,
  DefaultConfigurationResolver,
} from './binding-config';
import {
  BindingFilter,
  filterByKey,
  filterByTag,
  isBindingTagFilter,
} from './binding-filter';
import {BindingAddress, BindingKey} from './binding-key';
import {BindingComparator} from './binding-sorter';
import {ContextEvent} from './context-event';
import {ContextEventObserver, ContextObserver} from './context-observer';
import {ContextSubscriptionManager, Subscription} from './context-subscription';
import {ContextTagIndexer} from './context-tag-indexer';
import {ContextView} from './context-view';
import {ContextBindings} from './keys';
import {
  asResolutionOptions,
  ResolutionOptions,
  ResolutionOptionsOrSession,
  ResolutionSession,
} from './resolution-session';
import {
  BoundValue,
  getDeepProperty,
  isPromiseLike,
  ValueOrPromise,
} from './value-promise';

const debug = debugFactory('loopback:context');

/**
 * Context provides an implementation of Inversion of Control (IoC) container
 */
export class Context extends EventEmitter {
  /**
   * Name of the context
   */
  readonly name: string;

  /**
   * Key to binding map as the internal registry
   */
  protected readonly registry: Map<string, Binding> = new Map();

  /**
   * Indexer for bindings by tag
   */
  protected readonly tagIndexer: ContextTagIndexer;

  /**
   * Manager for observer subscriptions
   */
  readonly subscriptionManager: ContextSubscriptionManager;

  /**
   * Parent context
   */
  protected _parent?: Context;

  /**
   * Configuration resolver
   */
  protected configResolver: ConfigurationResolver;

  /**
   * Create a new context.
   *
   * @example
   * ```ts
   * // Create a new root context, let the framework to create a unique name
   * const rootCtx = new Context();
   *
   * // Create a new child context inheriting bindings from `rootCtx`
   * const childCtx = new Context(rootCtx);
   *
   * // Create another root context called "application"
   * const appCtx = new Context('application');
   *
   * // Create a new child context called "request" and inheriting bindings
   * // from `appCtx`
   * const reqCtx = new Context(appCtx, 'request');
   * ```
   * @param _parent - The optional parent context
   * @param name - Name of the context, if not provided, a `uuid` will be
   * generated as the name
   */
  constructor(_parent?: Context | string, name?: string) {
    super();
    // The number of listeners can grow with the number of child contexts
    // For example, each request can add a listener to the RestServer and the
    // listener is removed when the request processing is finished.
    // See https://github.com/strongloop/loopback-next/issues/4363
    this.setMaxListeners(Infinity);
    if (typeof _parent === 'string') {
      name = _parent;
      _parent = undefined;
    }
    this._parent = _parent;
    this.name = name ?? uuidv1();
    this.tagIndexer = new ContextTagIndexer(this);
    this.subscriptionManager = new ContextSubscriptionManager(this);
  }

  /**
   * @internal
   * Getter for ContextSubscriptionManager
   */
  get parent() {
    return this._parent;
  }

  /**
   * Wrap the debug statement so that it always print out the context name
   * as the prefix
   * @param args - Arguments for the debug
   */
  private _debug(...args: unknown[]) {
    /* istanbul ignore if */
    if (!debug.enabled) return;
    const formatter = args.shift();
    if (typeof formatter === 'string') {
      debug(`[%s] ${formatter}`, this.name, ...args);
    } else {
      debug('[%s] ', this.name, formatter, ...args);
    }
  }

  /**
   * A strongly-typed method to emit context events
   * @param type Event type
   * @param event Context event
   */
  emitEvent<T extends ContextEvent>(type: string, event: T) {
    this.emit(type, event);
  }

  /**
   * Emit an `error` event
   * @param err Error
   */
  emitError(err: unknown) {
    this.emit('error', err);
  }

  /**
   * Create a binding with the given key in the context. If a locked binding
   * already exists with the same key, an error will be thrown.
   *
   * @param key - Binding key
   */
  bind<ValueType = BoundValue>(
    key: BindingAddress<ValueType>,
  ): Binding<ValueType> {
    const binding = new Binding<ValueType>(key.toString());
    this.add(binding);
    return binding;
  }

  /**
   * Add a binding to the context. If a locked binding already exists with the
   * same key, an error will be thrown.
   * @param binding - The configured binding to be added
   */
  add(binding: Binding<unknown>): this {
    const key = binding.key;
    this._debug('[%s] Adding binding: %s', key);
    let existingBinding: Binding | undefined;
    const keyExists = this.registry.has(key);
    if (keyExists) {
      existingBinding = this.registry.get(key);
      const bindingIsLocked = existingBinding?.isLocked;
      if (bindingIsLocked)
        throw new Error(`Cannot rebind key "${key}" to a locked binding`);
    }
    this.registry.set(key, binding);
    if (existingBinding !== binding) {
      if (existingBinding != null) {
        this.emitEvent('unbind', {
          binding: existingBinding,
          context: this,
          type: 'unbind',
        });
      }
      this.emitEvent('bind', {binding, context: this, type: 'bind'});
    }
    return this;
  }

  /**
   * Create a corresponding binding for configuration of the target bound by
   * the given key in the context.
   *
   * For example, `ctx.configure('controllers.MyController').to({x: 1})` will
   * create binding `controllers.MyController:$config` with value `{x: 1}`.
   *
   * @param key - The key for the binding to be configured
   */
  configure<ConfigValueType = BoundValue>(
    key: BindingAddress = '',
  ): Binding<ConfigValueType> {
    const bindingForConfig = Binding.configure<ConfigValueType>(key);
    this.add(bindingForConfig);
    return bindingForConfig;
  }

  /**
   * Get the value or promise of configuration for a given binding by key
   *
   * @param key - Binding key
   * @param propertyPath - Property path for the option. For example, `x.y`
   * requests for `<config>.x.y`. If not set, the `<config>` object will be
   * returned.
   * @param resolutionOptions - Options for the resolution.
   * - optional: if not set or set to `true`, `undefined` will be returned if
   * no corresponding value is found. Otherwise, an error will be thrown.
   */
  getConfigAsValueOrPromise<ConfigValueType>(
    key: BindingAddress,
    propertyPath?: string,
    resolutionOptions?: ResolutionOptions,
  ): ValueOrPromise<ConfigValueType | undefined> {
    this.setupConfigurationResolverIfNeeded();
    return this.configResolver.getConfigAsValueOrPromise(
      key,
      propertyPath,
      resolutionOptions,
    );
  }

  /**
   * Set up the configuration resolver if needed
   */
  protected setupConfigurationResolverIfNeeded() {
    if (!this.configResolver) {
      // First try the bound ConfigurationResolver to this context
      const configResolver = this.getSync<ConfigurationResolver>(
        ContextBindings.CONFIGURATION_RESOLVER,
        {
          optional: true,
        },
      );
      if (configResolver) {
        debug(
          'Custom ConfigurationResolver is loaded from %s.',
          ContextBindings.CONFIGURATION_RESOLVER.toString(),
        );
        this.configResolver = configResolver;
      } else {
        // Fallback to DefaultConfigurationResolver
        debug('DefaultConfigurationResolver is used.');
        this.configResolver = new DefaultConfigurationResolver(this);
      }
    }
    return this.configResolver;
  }

  /**
   * Resolve configuration for the binding by key
   *
   * @param key - Binding key
   * @param propertyPath - Property path for the option. For example, `x.y`
   * requests for `<config>.x.y`. If not set, the `<config>` object will be
   * returned.
   * @param resolutionOptions - Options for the resolution.
   */
  async getConfig<ConfigValueType>(
    key: BindingAddress,
    propertyPath?: string,
    resolutionOptions?: ResolutionOptions,
  ): Promise<ConfigValueType | undefined> {
    return this.getConfigAsValueOrPromise<ConfigValueType>(
      key,
      propertyPath,
      resolutionOptions,
    );
  }

  /**
   * Resolve configuration synchronously for the binding by key
   *
   * @param key - Binding key
   * @param propertyPath - Property path for the option. For example, `x.y`
   * requests for `config.x.y`. If not set, the `config` object will be
   * returned.
   * @param resolutionOptions - Options for the resolution.
   */
  getConfigSync<ConfigValueType>(
    key: BindingAddress,
    propertyPath?: string,
    resolutionOptions?: ResolutionOptions,
  ): ConfigValueType | undefined {
    const valueOrPromise = this.getConfigAsValueOrPromise<ConfigValueType>(
      key,
      propertyPath,
      resolutionOptions,
    );
    if (isPromiseLike(valueOrPromise)) {
      const prop = propertyPath ? ` property ${propertyPath}` : '';
      throw new Error(
        `Cannot get config${prop} for ${key} synchronously: the value is a promise`,
      );
    }
    return valueOrPromise;
  }

  /**
   * Unbind a binding from the context. No parent contexts will be checked.
   *
   * @remarks
   * If you need to unbind a binding owned by a parent context, use the code
   * below:
   *
   * ```ts
   * const ownerCtx = ctx.getOwnerContext(key);
   * return ownerCtx != null && ownerCtx.unbind(key);
   * ```
   *
   * @param key - Binding key
   * @returns true if the binding key is found and removed from this context
   */
  unbind(key: BindingAddress): boolean {
    this._debug('Unbind %s', key);
    key = BindingKey.validate(key);
    const binding = this.registry.get(key);
    // If not found, return `false`
    if (binding == null) return false;
    if (binding?.isLocked)
      throw new Error(`Cannot unbind key "${key}" of a locked binding`);
    this.registry.delete(key);
    this.emitEvent('unbind', {binding, context: this, type: 'unbind'});
    return true;
  }

  /**
   * Add a context event observer to the context
   * @param observer - Context observer instance or function
   */
  subscribe(observer: ContextEventObserver): Subscription {
    return this.subscriptionManager.subscribe(observer);
  }

  /**
   * Remove the context event observer from the context
   * @param observer - Context event observer
   */
  unsubscribe(observer: ContextEventObserver): boolean {
    return this.subscriptionManager.unsubscribe(observer);
  }

  /**
   * Close the context: clear observers, stop notifications, and remove event
   * listeners from its parent context.
   *
   * @remarks
   * This method MUST be called to avoid memory leaks once a context object is
   * no longer needed and should be recycled. An example is the `RequestContext`,
   * which is created per request.
   */
  close() {
    this._debug('Closing context...');
    this.subscriptionManager.close();
    this.tagIndexer.close();
  }

  /**
   * Check if an observer is subscribed to this context
   * @param observer - Context observer
   */
  isSubscribed(observer: ContextObserver) {
    return this.subscriptionManager.isSubscribed(observer);
  }

  /**
   * Create a view of the context chain with the given binding filter
   * @param filter - A function to match bindings
   * @param comparator - A function to sort matched bindings
   */
  createView<T = unknown>(
    filter: BindingFilter,
    comparator?: BindingComparator,
  ) {
    const view = new ContextView<T>(this, filter, comparator);
    view.open();
    return view;
  }

  /**
   * Check if a binding exists with the given key in the local context without
   * delegating to the parent context
   * @param key - Binding key
   */
  contains(key: BindingAddress): boolean {
    key = BindingKey.validate(key);
    return this.registry.has(key);
  }

  /**
   * Check if a key is bound in the context or its ancestors
   * @param key - Binding key
   */
  isBound(key: BindingAddress): boolean {
    if (this.contains(key)) return true;
    if (this._parent) {
      return this._parent.isBound(key);
    }
    return false;
  }

  /**
   * Get the owning context for a binding key
   * @param key - Binding key
   */
  getOwnerContext(key: BindingAddress): Context | undefined {
    if (this.contains(key)) return this;
    if (this._parent) {
      return this._parent.getOwnerContext(key);
    }
    return undefined;
  }

  /**
   * Find bindings using a key pattern or filter function
   * @param pattern - A filter function, a regexp or a wildcard pattern with
   * optional `*` and `?`. Find returns such bindings where the key matches
   * the provided pattern.
   *
   * For a wildcard:
   * - `*` matches zero or more characters except `.` and `:`
   * - `?` matches exactly one character except `.` and `:`
   *
   * For a filter function:
   * - return `true` to include the binding in the results
   * - return `false` to exclude it.
   */
  find<ValueType = BoundValue>(
    pattern?: string | RegExp | BindingFilter,
  ): Readonly<Binding<ValueType>>[] {
    // Optimize if the binding filter is for tags
    if (typeof pattern === 'function' && isBindingTagFilter(pattern)) {
      return this._findByTagIndex(pattern.bindingTagPattern);
    }

    const bindings: Readonly<Binding<ValueType>>[] = [];
    const filter = filterByKey(pattern);

    for (const b of this.registry.values()) {
      if (filter(b)) bindings.push(b);
    }

    const parentBindings = this._parent && this._parent.find(filter);
    return this._mergeWithParent(bindings, parentBindings);
  }

  /**
   * Find bindings using the tag filter. If the filter matches one of the
   * binding tags, the binding is included.
   *
   * @param tagFilter - A filter for tags. It can be in one of the following
   * forms:
   * - A regular expression, such as `/controller/`
   * - A wildcard pattern string with optional `*` and `?`, such as `'con*'`
   *   For a wildcard:
   *   - `*` matches zero or more characters except `.` and `:`
   *   - `?` matches exactly one character except `.` and `:`
   * - An object containing tag name/value pairs, such as
   * `{name: 'my-controller'}`
   */
  findByTag<ValueType = BoundValue>(
    tagFilter: BindingTag | RegExp,
  ): Readonly<Binding<ValueType>>[] {
    return this.find(filterByTag(tagFilter));
  }

  /**
   * Find bindings by tag leveraging indexes
   * @param tag - Tag name pattern or name/value pairs
   */
  protected _findByTagIndex<ValueType = BoundValue>(
    tag: BindingTag | RegExp,
  ): Readonly<Binding<ValueType>>[] {
    const currentBindings = this.tagIndexer.findByTagIndex(tag);
    const parentBindings = this._parent && this._parent?._findByTagIndex(tag);
    return this._mergeWithParent(currentBindings, parentBindings);
  }

  protected _mergeWithParent<ValueType>(
    childList: Readonly<Binding<ValueType>>[],
    parentList?: Readonly<Binding<ValueType>>[],
  ) {
    if (!parentList) return childList;
    const additions = parentList.filter(parentBinding => {
      // children bindings take precedence
      return !childList.some(
        childBinding => childBinding.key === parentBinding.key,
      );
    });
    return childList.concat(additions);
  }

  /**
   * Get the value bound to the given key, throw an error when no value is
   * bound for the given key.
   *
   * @example
   *
   * ```ts
   * // get the value bound to "application.instance"
   * const app = await ctx.get<Application>('application.instance');
   *
   * // get "rest" property from the value bound to "config"
   * const config = await ctx.get<RestComponentConfig>('config#rest');
   *
   * // get "a" property of "numbers" property from the value bound to "data"
   * ctx.bind('data').to({numbers: {a: 1, b: 2}, port: 3000});
   * const a = await ctx.get<number>('data#numbers.a');
   * ```
   *
   * @param keyWithPath - The binding key, optionally suffixed with a path to the
   *   (deeply) nested property to retrieve.
   * @param session - Optional session for resolution (accepted for backward
   * compatibility)
   * @returns A promise of the bound value.
   */
  get<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    session?: ResolutionSession,
  ): Promise<ValueType>;

  /**
   * Get the value bound to the given key, optionally return a (deep) property
   * of the bound value.
   *
   * @example
   *
   * ```ts
   * // get "rest" property from the value bound to "config"
   * // use `undefined` when no config is provided
   * const config = await ctx.get<RestComponentConfig>('config#rest', {
   *   optional: true
   * });
   * ```
   *
   * @param keyWithPath - The binding key, optionally suffixed with a path to the
   *   (deeply) nested property to retrieve.
   * @param options - Options for resolution.
   * @returns A promise of the bound value, or a promise of undefined when
   * the optional binding is not found.
   */
  get<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    options: ResolutionOptions,
  ): Promise<ValueType | undefined>;

  // Implementation
  async get<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    optionsOrSession?: ResolutionOptionsOrSession,
  ): Promise<ValueType | undefined> {
    this._debug('Resolving binding: %s', keyWithPath);
    return this.getValueOrPromise<ValueType | undefined>(
      keyWithPath,
      optionsOrSession,
    );
  }

  /**
   * Get the synchronous value bound to the given key, optionally
   * return a (deep) property of the bound value.
   *
   * This method throws an error if the bound value requires async computation
   * (returns a promise). You should never rely on sync bindings in production
   * code.
   *
   * @example
   *
   * ```ts
   * // get the value bound to "application.instance"
   * const app = ctx.getSync<Application>('application.instance');
   *
   * // get "rest" property from the value bound to "config"
   * const config = await ctx.getSync<RestComponentConfig>('config#rest');
   * ```
   *
   * @param keyWithPath - The binding key, optionally suffixed with a path to the
   *   (deeply) nested property to retrieve.
   * @param session - Session for resolution (accepted for backward compatibility)
   * @returns A promise of the bound value.
   */
  getSync<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    session?: ResolutionSession,
  ): ValueType;

  /**
   * Get the synchronous value bound to the given key, optionally
   * return a (deep) property of the bound value.
   *
   * This method throws an error if the bound value requires async computation
   * (returns a promise). You should never rely on sync bindings in production
   * code.
   *
   * @example
   *
   * ```ts
   * // get "rest" property from the value bound to "config"
   * // use "undefined" when no config is provided
   * const config = await ctx.getSync<RestComponentConfig>('config#rest', {
   *   optional: true
   * });
   * ```
   *
   * @param keyWithPath - The binding key, optionally suffixed with a path to the
   *   (deeply) nested property to retrieve.
   * @param options - Options for resolution.
   * @returns The bound value, or undefined when an optional binding is not found.
   */
  getSync<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    options?: ResolutionOptions,
  ): ValueType | undefined;

  // Implementation
  getSync<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    optionsOrSession?: ResolutionOptionsOrSession,
  ): ValueType | undefined {
    this._debug('Resolving binding synchronously: %s', keyWithPath);

    const valueOrPromise = this.getValueOrPromise<ValueType>(
      keyWithPath,
      optionsOrSession,
    );

    if (isPromiseLike(valueOrPromise)) {
      throw new Error(
        `Cannot get ${keyWithPath} synchronously: the value is a promise`,
      );
    }

    return valueOrPromise;
  }

  /**
   * Look up a binding by key in the context and its ancestors. If no matching
   * binding is found, an error will be thrown.
   *
   * @param key - Binding key
   */
  getBinding<ValueType = BoundValue>(
    key: BindingAddress<ValueType>,
  ): Binding<ValueType>;

  /**
   * Look up a binding by key in the context and its ancestors. If no matching
   * binding is found and `options.optional` is not set to true, an error will
   * be thrown.
   *
   * @param key - Binding key
   * @param options - Options to control if the binding is optional. If
   * `options.optional` is set to true, the method will return `undefined`
   * instead of throwing an error if the binding key is not found.
   */
  getBinding<ValueType>(
    key: BindingAddress<ValueType>,
    options?: {optional?: boolean},
  ): Binding<ValueType> | undefined;

  getBinding<ValueType>(
    key: BindingAddress<ValueType>,
    options?: {optional?: boolean},
  ): Binding<ValueType> | undefined {
    key = BindingKey.validate(key);
    const binding = this.registry.get(key);
    if (binding) {
      return binding;
    }

    if (this._parent) {
      return this._parent.getBinding<ValueType>(key, options);
    }

    if (options?.optional) return undefined;
    throw new Error(
      `The key '${key}' is not bound to any value in context ${this.name}`,
    );
  }

  /**
   * Find or create a binding for the given key
   * @param key - Binding address
   * @param policy - Binding creation policy
   */
  findOrCreateBinding<T>(
    key: BindingAddress<T>,
    policy?: BindingCreationPolicy,
  ) {
    let binding: Binding<T>;
    if (policy === BindingCreationPolicy.ALWAYS_CREATE) {
      binding = this.bind(key);
    } else if (policy === BindingCreationPolicy.NEVER_CREATE) {
      binding = this.getBinding(key);
    } else if (this.isBound(key)) {
      // CREATE_IF_NOT_BOUND - the key is bound
      binding = this.getBinding(key);
    } else {
      // CREATE_IF_NOT_BOUND - the key is not bound
      binding = this.bind(key);
    }
    return binding;
  }

  /**
   * Get the value bound to the given key.
   *
   * This is an internal version that preserves the dual sync/async result
   * of `Binding#getValue()`. Users should use `get()` or `getSync()` instead.
   *
   * @example
   *
   * ```ts
   * // get the value bound to "application.instance"
   * ctx.getValueOrPromise<Application>('application.instance');
   *
   * // get "rest" property from the value bound to "config"
   * ctx.getValueOrPromise<RestComponentConfig>('config#rest');
   *
   * // get "a" property of "numbers" property from the value bound to "data"
   * ctx.bind('data').to({numbers: {a: 1, b: 2}, port: 3000});
   * ctx.getValueOrPromise<number>('data#numbers.a');
   * ```
   *
   * @param keyWithPath - The binding key, optionally suffixed with a path to the
   *   (deeply) nested property to retrieve.
   * @param optionsOrSession - Options for resolution or a session
   * @returns The bound value or a promise of the bound value, depending
   *   on how the binding is configured.
   * @internal
   */
  getValueOrPromise<ValueType>(
    keyWithPath: BindingAddress<ValueType>,
    optionsOrSession?: ResolutionOptionsOrSession,
  ): ValueOrPromise<ValueType | undefined> {
    const {key, propertyPath} = BindingKey.parseKeyWithPath(keyWithPath);

    optionsOrSession = asResolutionOptions(optionsOrSession);

    const binding = this.getBinding<ValueType>(key, optionsOrSession);
    if (binding == null) return undefined;

    const boundValue = binding.getValue(this, optionsOrSession);
    if (propertyPath === undefined || propertyPath === '') {
      return boundValue;
    }

    if (isPromiseLike(boundValue)) {
      return boundValue.then(v => getDeepProperty<ValueType>(v, propertyPath));
    }

    return getDeepProperty<ValueType>(boundValue, propertyPath);
  }

  /**
   * Create a plain JSON object for the context
   */
  toJSON(): object {
    const bindings: Record<string, object> = {};
    for (const [k, v] of this.registry) {
      bindings[k] = v.toJSON();
    }
    return bindings;
  }

  /**
   * Inspect the context and dump out a JSON object representing the context
   * hierarchy
   */
  // TODO(rfeng): Evaluate https://nodejs.org/api/util.html#util_custom_inspection_functions_on_objects
  inspect(): object {
    const json: Record<string, unknown> = {
      name: this.name,
      bindings: this.toJSON(),
    };
    if (this._parent) {
      json.parent = this._parent.inspect();
    }
    return json;
  }
}

/**
 * Policy to control if a binding should be created for the context
 */
export enum BindingCreationPolicy {
  /**
   * Always create a binding with the key for the context
   */
  ALWAYS_CREATE = 'Always',
  /**
   * Never create a binding for the context. If the key is not bound in the
   * context, throw an error.
   */
  NEVER_CREATE = 'Never',
  /**
   * Create a binding if the key is not bound in the context. Otherwise, return
   * the existing binding.
   */
  CREATE_IF_NOT_BOUND = 'IfNotBound',
}
