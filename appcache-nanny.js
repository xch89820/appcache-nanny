// appCacheNanny
// =============
//
// Teaches your applicationCache some manners! Because, you know,
// http://alistapart.com/article/application-cache-is-a-douchebag
//

/* global define */
'use strict';

(function (root, factory) {
    var appCache = (typeof applicationCache === 'undefined') ? undefined : applicationCache;

    // Based on https://github.com/allouis/minivents/blob/master/minivents.js
    function Events(target){
        var events = {};
        target = target || this;
        /**
         *  On: listen to events
         */
        target.on = function(type, func, ctx){
            (events[type] = events[type] || []).push({f:func, c:ctx})
        };
        /**
         * One: listen to events once
         * @param type
         * @param func
         * @param ctx
         */
        target.one = function(type, func, ctx){
            (events[type] = events[type] || []).push(
                {f:function(){
                    func.apply(ctx, arguments);
                    target.off(type, func);
                }, c:ctx}
            )
        };
        /**
         *  Off: stop listening to event / specific callback
         */
        target.off = function(type, func){
            type || (events = {})
            var list = events[type] || [],
                i = list.length = func ? list.length : 0
            while(i-->0) func == list[i].f && list.splice(i,1)
        };
        /**
         * Emit: send event, callbacks will be triggered
         */
        target.emit = function(){
            var args = Array.apply([], arguments),
                list = events[args.shift()] || [], i=0, j
            for(;j=list[i++];) j.f.apply(j.c, args)
        };
    }

    if (typeof define === 'function' && define.amd) {
        define([], function () {
            root.appCacheNanny = factory(appCache, Events);
            return root.appCacheNanny;
        });
    } else if (typeof exports === 'object') {
        module.exports = factory(appCache, Events);
    } else {
        root.appCacheNanny = new (factory(appCache, Events));
    }
})(this, function(applicationCache, Events){

    var nannyOptions = {
        loaderPath: '/appcache-loader.html',
        checkInterval: 30000,
        offlineCheckInterval: 30000
    };

    var noop = function(){};
    var APPCACHE_STORE_KEY = '_appcache_nanny';

    var appCacheNanny = function(options){
        // Merge options
        this.options = options || {};
        this.options.loaderPath = this.options.loaderPath || nannyOptions.loaderPath;
        this.options.checkInterval = this.options.checkInterval || nannyOptions.checkInterval;
        this.options.offlineCheckInterval = this.options.offlineCheckInterval || nannyOptions.offlineCheckInterval;
        // Setup status
        this.setupDone = false;
        this.setupPending = false;
        // Flag if there is a pending update, being applied after next page reload
        this.hasUpdateFlag = false;
        // Flag whether the nanny is checking for updates in the background
        this.isCheckingForUpdatesFlag = false;
        // Flag if there was an error updating the appCache, usually meaning
        // it couldn't connect, a.k.a. you're offline.
        this.hasNetworkError = false;
        this.isInitialDownload = false;

        // This is the internal state of checkInterval.
        // It usually differs between online / offline state
        //this.checkInterval = nannyOptions.checkInterval;
        // The checker handler
        this.intervalPointer = null;

        // Snapshot applicationCache
        this.applicationCache = this.options.applicationCache || applicationCache;
        // Save the iframe hook for application cache
        this.ifameHook = null;

        // Initialization Event
        Events(this);

        // Setup callback
        this.setupProcess = new Events();
    };

    /**
     * Check current page or iframe hook's page whether or not support applicationCache future
     *
     * @returns {boolean}
     */
    appCacheNanny.prototype.isSupported = function(){
        return !!this.applicationCache;
    };

    /**
     * Start to AppCache refresh
     * @returns {boolean}
     */
    appCacheNanny.prototype.start = function () {
        var me = this;

        if (!me.isSupported()){
            console.log("Not support application cache");
            return false;
        }
        if (!me.setupDone) {
            this.setupProcess.one('finished', me.start ,me);

            if (!me.setupPending) {
                me.setup();
                me.setupPending = true;
            }
            return true;
        }

        // First, try to stop previous loop
        me.stop();

        // check with offline interval
        var checkInterval = me.hasNetworkError ?
            me.options.offlineCheckInterval:
            me.options.checkInterval;

        me.intervalPointer = setInterval(function(){
            me.update.apply(me, arguments);
        }, checkInterval);
        me.isCheckingForUpdatesFlag = true;

        me.emit('start');
    };

    /**
     * Stop to AppCache refresh
     * @returns {boolean}
     */
    appCacheNanny.prototype.stop = function() {
        if (!this.isCheckingForUpdatesFlag || !this.intervalPointer) return;

        clearInterval(this.intervalPointer);
        this.isCheckingForUpdatesFlag = false;

        this.emit('stop');
    };

    /**
     * Update to AppCache
     * @returns {boolean}
     */
    appCacheNanny.prototype.update = function() {
        var me = this;

        if (!me.isSupported()) return false;
        if (!me.setupDone) {
            this.setupProcess.one('finished', me.update ,me);
            if (!me.setupPending) {
                me.setup();
                me.setupPending = true;
            }
            return true;
        }

        try {
            me.applicationCache.update();
            me.emit('update');
            return true;
        } catch (e) {
            // there might still be cases when ApplicationCache is not support
            // e.g. in Chrome, when returned HTML is status code 40X, or if
            // the applicationCache became obsolete
            me.update = noop;
            return false;
        }
    };

    /**
     * Returns true if the nanny is checking periodically for updates
     *
     * @returns {Function}
     */
    appCacheNanny.prototype.isCheckingForUpdates = function(){
        return this.isCheckingForUpdatesFlag;
    };

    /**
     * Returns true if an update has been fully received, otherwise false
     *
     * @returns {Function}
     */
    appCacheNanny.prototype.hasUpdate = function () {
        return this.hasUpdateFlag;
    };


    /**
     * Setup appCache work
     *
     */
    appCacheNanny.prototype.setup = function() {
        var me = this, iframe, scriptTag;

        if (!me.isSupported()) {
            me.update = noop;
            return;
        }

        try {
            me.isInitialDownload = !localStorage.getItem(APPCACHE_STORE_KEY);
            localStorage.setItem(APPCACHE_STORE_KEY, '1');
        } catch(e) {}

        // https://github.com/gr2m/appcache-nanny/issues/7
        if (me.applicationCache.status !== me.applicationCache.UNCACHED) {
            return me._setupFinished();
        }

        // Load the fallback html via an iframe
        iframe = document.createElement('iframe');
        iframe.src = me.options.loaderPath;
        iframe.style.display = 'none';
        iframe.onload = function() {
            // we use the iFrame's applicationCache Object now
            me.applicationCache = iframe.contentWindow.applicationCache;
            me._setupFinished();
        };
        iframe.onerror = function() {
            throw new Error('/appcache-loader.html could not be loaded.');
        };
        me.ifameHook = iframe;

        scriptTag = document.getElementsByTagName('script')[0];
        scriptTag.parentNode.insertBefore(iframe,scriptTag);
    };

    /**
     * Inner call after setup finished
     *
     * @private
     */
    appCacheNanny.prototype._setupFinished = function(){
        this.subscribeToEvents();
        this.setupPending = false;
        this.setupDone = true;
        this.setupProcess.emit('finished');
    };

    /**
     * Subscribe application cache events
     * @returns {boolean}
     */
    appCacheNanny.prototype.subscribeToEvents = function(){
        var me = this;
        if (!me.isSupported()) return false;

        // Short cut addEventListener
        function on(eventName, callback) {
            me.applicationCache.addEventListener(eventName, function(){
                callback.apply(me, arguments);
            }, false);
        }

        // Fired when the manifest resources have been downloaded.
        on('updateready', me.handleUpdateReady);

        // fired when manifest download request failed
        // (no connection or 5xx server response)
        on('error',        me.handleNetworkError);

        // fired when manifest download request succeeded
        // but server returned 404 / 410
        on('obsolete',     me.handleNetworkObsolete);

        // fired when manifest download succeeded
        on('noupdate',     me.handleNetworkSucces);
        on('cached',       me.handleNetworkSucces);
        on('updateready',  me.handleNetworkSucces);
        on('progress',     me.handleNetworkSucces);
        on('downloading', me. handleNetworkSucces);

        // when browser goes online/offline, look for updates to make sure.
        window.addEventListener("online", me.update, false);
        window.addEventListener("offline", me.update, false);
    };

    appCacheNanny.prototype.handleUpdateReady = function() {
        // I have seen both Chorme & Firefox throw exceptions when trying
        // to swap cache on updateready. I was not able to reproduce it,
        // but for the sake of sanity, I'm making it fail silently
        try {
            if (!this.hasUpdateFlag) {
                this.hasUpdateFlag = true;
                // don't use trigger here, otherwise the event wouldn't get triggered
                this.emit('updateready');
            }
            this.applicationCache.swapCache();
        } catch(error) {}
    };

    appCacheNanny.prototype.handleNetworkSucces = function(event) {
        var me = this;
        var prefix = '';

        // when page gets opened for the very first time, it already has
        // the correct assets, but appCache still triggers 'downloading',
        // 'progress' and 'cached' events. Once the first 'cached' event
        // gets triggered, all assets are cached offline. We prefix these
        // initial events with 'init:'
        if (me.isInitialDownload) {
            prefix = 'init:';
            if (event.type === 'cached') {
                me.isInitialDownload = false;
            }
        }

        // re-trigger event via appCacheNanny
        me.emit(prefix + event.type);

        if (!me.hasNetworkError) return;
        me.hasNetworkError = false;

        me.start();
        me.emit('online');
    };

    appCacheNanny.prototype.handleNetworkError = function() {
        var me = this;
        // re-trigger event via appCacheNanny
        me.emit('error');

        if (me.hasNetworkError) return;
        me.hasNetworkError = true;

        // Edge case: private mode in Safari & FF say they support applicationCache,
        // but they fail. To get around that, we only trigger the offline event
        // when applicationCache.status != uncached
        if (me.applicationCache.status === me.applicationCache.UNCACHED) return;

        me.start();
        me.emit('offline');
    };

    //
    // The 'obsolete' event gets triggered if the requested *.appcache file
    // has been removed or renamed. The intent behind renaming an *.appcache
    // file is to clear all locally cached files, it's the only way to do so.
    // Therefore we don't treet it as an error, it usually means that there
    // is an update availble that becomes visible after the next page reload.
    //
    appCacheNanny.prototype.handleNetworkObsolete = function() {
        var me = this;
        // re-trigger event via appCacheNanny
        me.emit('obsolete');

        if (me.hasNetworkError) {
            me.hasNetworkError = false;
            me.emit('online');
        }

        // Once applicationCache status is obsolete, calling .udate() throws
        // an error, so we stop checking here
        me.stop();
    };

    /**
     * Get optoins
     * @param name
     * @returns {*}
     */
    appCacheNanny.prototype.get = function(name){
        return this.options[name];
    };

    /**
     * Set optoins
     * @param name
     * @returns {*}
     */
    appCacheNanny.prototype.set = function(name, value){
        return this.options[name] = value;
    };

    return appCacheNanny;

});
