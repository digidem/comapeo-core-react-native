#include <jni.h>
#include <string>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

// cache the environment variable for the thread running node to call into java
JNIEnv* cacheEnvPointer=NULL;
const char *ADBTAG = "NODEJS-MOBILE";

#if defined(__arm__)
    #define CURRENT_ABI_NAME "armeabi-v7a"
#elif defined(__aarch64__)
    #define CURRENT_ABI_NAME "arm64-v8a"
#elif defined(__i386__)
    #define CURRENT_ABI_NAME "x86"
#elif defined(__x86_64__)
    #define CURRENT_ABI_NAME "x86_64"
#else
    #error "Trying to compile for an unknown ABI."
#endif

void log(const char *message, ...) {
    va_list args;
    va_start(args, message);
    __android_log_vprint(ANDROID_LOG_INFO, ADBTAG, message, args);
    va_end(args);
}

extern "C"
JNIEXPORT jstring JNICALL
Java_com_comapeo_core_ComapeoCoreService_getCurrentABIName(JNIEnv *env, jclass clazz) {
    return env->NewStringUTF(CURRENT_ABI_NAME);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_comapeo_core_ComapeoCoreService_initialize(JNIEnv *env, jclass clazz, jstring dataDir) {
    const char* nativeDataDir = env->GetStringUTFChars(dataDir, 0);
    log("initialize: %s", nativeDataDir);
    env->ReleaseStringUTFChars(dataDir, nativeDataDir);
}