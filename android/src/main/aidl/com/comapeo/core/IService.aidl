package com.comapeo.core;

import com.comapeo.core.IServiceCallback;

interface IService {
    int getCurrentState();
    void registerCallback(IServiceCallback callback);
    void unregisterCallback(IServiceCallback callback);
}
