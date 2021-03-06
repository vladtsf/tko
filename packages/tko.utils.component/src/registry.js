
import {
  subscribable, dependencyDetection
} from 'tko.observable'

import {
  getObjectOwnProperty, tasks
} from 'tko.utils'

var loadingSubscribablesCache = {}, // Tracks component loads that are currently in flight
  loadedDefinitionsCache = {}    // Tracks component loads that have already completed

function loadComponentAndNotify (componentName, callback) {
  var _subscribable = getObjectOwnProperty(loadingSubscribablesCache, componentName),
    completedAsync
  if (!_subscribable) {
        // It's not started loading yet. Start loading, and when it's done, move it to loadedDefinitionsCache.
    _subscribable = loadingSubscribablesCache[componentName] = new subscribable()
    _subscribable.subscribe(callback)

    beginLoadingComponent(componentName, function (definition, config) {
      var isSynchronousComponent = !!(config && config.synchronous)
      loadedDefinitionsCache[componentName] = { definition: definition, isSynchronousComponent: isSynchronousComponent }
      delete loadingSubscribablesCache[componentName]

            // For API consistency, all loads complete asynchronously. However we want to avoid
            // adding an extra task schedule if it's unnecessary (i.e., the completion is already
            // async).
            //
            // You can bypass the 'always asynchronous' feature by putting the synchronous:true
            // flag on your component configuration when you register it.
      if (completedAsync || isSynchronousComponent) {
                // Note that notifySubscribers ignores any dependencies read within the callback.
                // See comment in loaderRegistryBehaviors.js for reasoning
        _subscribable.notifySubscribers(definition)
      } else {
        tasks.schedule(function () {
          _subscribable.notifySubscribers(definition)
        })
      }
    })
    completedAsync = true
  } else {
    _subscribable.subscribe(callback)
  }
}

function beginLoadingComponent (componentName, callback) {
  getFirstResultFromLoaders('getConfig', [componentName], function (config) {
    if (config) {
            // We have a config, so now load its definition
      getFirstResultFromLoaders('loadComponent', [componentName, config], function (definition) {
        callback(definition, config)
      })
    } else {
            // The component has no config - it's unknown to all the loaders.
            // Note that this is not an error (e.g., a module loading error) - that would abort the
            // process and this callback would not run. For this callback to run, all loaders must
            // have confirmed they don't know about this component.
      callback(null, null)
    }
  })
}

function getFirstResultFromLoaders (methodName, argsExceptCallback, callback, candidateLoaders) {
    // On the first call in the stack, start with the full set of loaders
  if (!candidateLoaders) {
    candidateLoaders = registry.loaders.slice(0) // Use a copy, because we'll be mutating this array
  }

    // Try the next candidate
  var currentCandidateLoader = candidateLoaders.shift()
  if (currentCandidateLoader) {
    var methodInstance = currentCandidateLoader[methodName]
    if (methodInstance) {
      var wasAborted = false,
        synchronousReturnValue = methodInstance.apply(currentCandidateLoader, argsExceptCallback.concat(function (result) {
          if (wasAborted) {
            callback(null)
          } else if (result !== null) {
                        // This candidate returned a value. Use it.
            callback(result)
          } else {
                        // Try the next candidate
            getFirstResultFromLoaders(methodName, argsExceptCallback, callback, candidateLoaders)
          }
        }))

            // Currently, loaders may not return anything synchronously. This leaves open the possibility
            // that we'll extend the API to support synchronous return values in the future. It won't be
            // a breaking change, because currently no loader is allowed to return anything except undefined.
      if (synchronousReturnValue !== undefined) {
        wasAborted = true

                // Method to suppress exceptions will remain undocumented. This is only to keep
                // KO's specs running tidily, since we can observe the loading got aborted without
                // having exceptions cluttering up the console too.
        if (!currentCandidateLoader.suppressLoaderExceptions) {
          throw new Error('Component loaders must supply values by invoking the callback, not by returning values synchronously.')
        }
      }
    } else {
            // This candidate doesn't have the relevant handler. Synchronously move on to the next one.
      getFirstResultFromLoaders(methodName, argsExceptCallback, callback, candidateLoaders)
    }
  } else {
        // No candidates returned a value
    callback(null)
  }
}

export var registry = {
  get (componentName, callback) {
    var cachedDefinition = getObjectOwnProperty(loadedDefinitionsCache, componentName)
    if (cachedDefinition) {
      // It's already loaded and cached. Reuse the same definition object.
      // Note that for API consistency, even cache hits complete asynchronously by default.
      // You can bypass this by putting synchronous:true on your component config.
      if (cachedDefinition.isSynchronousComponent) {
        dependencyDetection.ignore(function () { // See comment in loaderRegistryBehaviors.js for reasoning
          callback(cachedDefinition.definition)
        })
      } else {
        tasks.schedule(function () { callback(cachedDefinition.definition) })
      }
    } else {
      // Join the loading process that is already underway, or start a new one.
      loadComponentAndNotify(componentName, callback)
    }
  },

  clearCachedDefinition (componentName) {
    delete loadedDefinitionsCache[componentName]
  },

  _getFirstResultFromLoaders: getFirstResultFromLoaders,

  loaders: []
}
