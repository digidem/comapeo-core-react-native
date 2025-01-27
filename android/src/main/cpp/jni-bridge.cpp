#include <jni.h>
#include "log.h"

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

extern "C"
JNIEXPORT jstring JNICALL
Java_com_comapeo_core_ComapeoCoreService_getCurrentABIName(JNIEnv *env, [[maybe_unused]] jclass clazz) {
    log("getCurrentABIName: %s", CURRENT_ABI_NAME);
    return env->NewStringUTF(CURRENT_ABI_NAME);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_comapeo_core_ComapeoCoreService_initialize(JNIEnv *env, [[maybe_unused]] jclass clazz, jstring dataDir) {
    const char* nativeDataDir = env->GetStringUTFChars(dataDir, nullptr);
    log("initialize: %s", nativeDataDir);
    env->ReleaseStringUTFChars(dataDir, nativeDataDir);
}