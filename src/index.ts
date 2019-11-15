import produce, { Draft } from 'immer'
import {
  useState,
  useEffect,
  useRef,
  SetStateAction,
  Dispatch,
  useMemo
} from 'react'

function generateKey(name: string) {
  return name + ':' + (+new Date() + Math.random()).toString(36)
}

type SetState<S> = (draft: Draft<S>) => void | S | Promise<void | S>

interface Actions<S> {
  [key: string]: (...payload: any[]) => SetState<S>
}

const PersistedStore = new Map()
function getPersistedStore<S>(key: string): S | null {
  return PersistedStore.get(key)
}

function setPersistedStore<S>(key: string, state: S) {
  return PersistedStore.set(key, state)
}

export interface IPersistedStorage<S> {
  generateKey?(name: string): string
  set(key: string, value: S, preValue?: S): void
  get(key: string): S | null
}

export interface IStoreOptions<S = {}> {
  name?: string
  persist?: IPersistedStorage<S> | boolean
}

type ArgumentTypes<T> = T extends (...args: infer U) => infer R ? U : never
type ReplaceReturnType<T, TNewReturn> = (...a: ArgumentTypes<T>) => TNewReturn
type ReturnActions<S, A extends Actions<S>> = {
  [K in keyof A]: ReplaceReturnType<A[K], void>
}
type Updater<S> = Dispatch<SetStateAction<S>>
type Return<S, A extends Actions<S>> = [Readonly<S>, ReturnActions<S, A>]

const DEFAULT_STORE_NAME = 'east-store'

function isStorage(obj: any) {
  if (obj && typeof obj.set === 'function' && typeof obj.get === 'function') {
    return true
  }
  throw new Error('Expect a valid storage implementation')
}

interface Store<S, A extends Actions<S>> {
  useStore: () => Return<S, A>
  getState: (transient?: boolean) => Readonly<S>
  getActions: () => ReturnActions<S, A>
  readonly length: number
}

/**
 * @description createStore with initialState and reducers
 * @param initialState
 * @param reducers
 * @param options
 */
export function createStore<S, R extends Actions<S>>(
  initialState: S,
  reducers: R,
  options?: IStoreOptions<S>
) {
  let isPersisted = !!(options && options.persist === true)
  let name = (options && options.name) || DEFAULT_STORE_NAME
  let storage: IPersistedStorage<S> = {
    set: setPersistedStore,
    get: getPersistedStore,
    generateKey
  }
  if (
    options &&
    typeof options.persist === 'object' &&
    isStorage(options.persist)
  ) {
    isPersisted = true
    storage = options.persist
  }

  storage.generateKey = storage.generateKey || generateKey

  // generate key for storage
  const key = storage.generateKey(name)
  // use a set to cache all updaters that share this state
  let updaters = new Set<Dispatch<SetStateAction<S>>>()
  // shared state's current value
  let transientState = initialState
  let commitedState = initialState
  let currentActions: ReturnActions<S, R>

  function borrowCheck() {
    if (!currentActions) {
      throw new Error('No alive components with used the store')
    }
  }

  let store = {
    getState: (transient?: boolean) => {
      return transient ? transientState : commitedState
    },
    getActions: () => {
      borrowCheck()
      return currentActions
    },
    get length() {
      return updaters.size
    }
  } as Store<S, R>

  function performUpdate(state: S) {
    updaters.forEach(setState => setState(state))
    // update peristed storage even though there is no component alive
    if (updaters.size === 0 && isPersisted) {
      storage.set(key, state)
    }
    transientState = state
  }

  const useProxy = (state: S) => {
    let proxy: ReturnActions<S, R>
    const mapActions = (key: string) => (...args: any[]) => {
      const setState = reducers[key](...args) as any
      const result = produce(state, draft => {
        return setState(draft, proxy)
      })
      if (typeof Promise !== 'undefined' && result instanceof Promise) {
        result.then(performUpdate)
      } else {
        performUpdate(result)
      }
    }
    if (typeof Proxy !== 'undefined') {
      proxy = new Proxy(reducers, {
        get(target, key, desc) {
          return mapActions(key as string)
        }
      })
    } else {
      proxy = Object.keys(reducers).reduce(
        (pre: any, key: string) => {
          pre[key] = mapActions(key)
          return pre
        },
        {} as R
      )
    }
    currentActions = proxy
    return proxy
  }

  function usePersistedEffect(state: S) {
    const didMount = useRef(false)
    useEffect(() => {
      didMount.current && storage.set(key, state)
      didMount.current = true
    }, [state])
  }

  function reset() {
    commitedState = transientState = initialState
    currentActions = null as any
  }

  function useSharedEffect(state: S, updateState: Updater<S>) {
    useEffect(() => {
      commitedState = state
      updaters.add(updateState)
      return () => {
        updaters.delete(updateState)
      }
    }, [state, updateState])

    // when all components been unmount, reset sharedState
    useEffect(
      () => () => {
        if (updaters.size === 0) reset()
      },
      []
    )
  }

  function useSharedStore(): Return<S, R> {
    const [state, updateState] = useState(commitedState)
    useSharedEffect(state, updateState)

    const p = useMemo(() => useProxy(state), [state])
    return [state, p]
  }

  function usePersistedSharedStore(): Return<S, R> {
    const [state, updateState] = useState(
      storage.get(key as string) || commitedState
    )

    useSharedEffect(state, updateState)
    usePersistedEffect(state)

    const p = useMemo(() => useProxy(state), [state])
    return [state, p]
  }

  store.useStore = isPersisted ? usePersistedSharedStore : useSharedStore

  return store
}
