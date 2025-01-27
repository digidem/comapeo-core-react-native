#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <string>
#include <android/log.h>

#include "node.h"
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
Java_com_comapeo_core_ComapeoCoreService_getCurrentABIName(JNIEnv *env,
                                                           [[maybe_unused]] jclass clazz) {
    log("getCurrentABIName: %s", CURRENT_ABI_NAME);
    return env->NewStringUTF(CURRENT_ABI_NAME);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_comapeo_core_ComapeoCoreService_initialize(JNIEnv *env, [[maybe_unused]] jclass clazz,
                                                    jstring dataDir) {
    const char *nativeDataDir = env->GetStringUTFChars(dataDir, nullptr);
    log("initialize: %s", nativeDataDir);
    env->ReleaseStringUTFChars(dataDir, nativeDataDir);
}

// Start threads to redirect stdout and stderr to logcat.
int pipe_stdout[2];
int pipe_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;

void *thread_stderr_func(void *) {
    ssize_t redirect_size;
    char buf[2048];
    while ((redirect_size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        //__android_log will add a new line anyway.
        if (buf[redirect_size - 1] == '\n')
            --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
    }
    return nullptr;
}

void *thread_stdout_func(void *) {
    ssize_t redirect_size;
    char buf[2048];
    while ((redirect_size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        //__android_log will add a new line anyway.
        if (buf[redirect_size - 1] == '\n')
            --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
    }
    return nullptr;
}

int start_redirecting_stdout_stderr() {
    //set stdout as unbuffered.
    setvbuf(stdout, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    //set stderr as unbuffered.
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if (pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr) != 0)
        return -1;
    pthread_detach(thread_stdout);

    if (pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr) != 0)
        return -1;
    pthread_detach(thread_stderr);

    return 0;
}

//node's libUV requires all arguments being on contiguous memory.
extern "C" jint JNICALL
Java_com_comapeo_core_ComapeoCoreService_startNodeWithArguments(
        JNIEnv *env,
        [[maybe_unused]] jclass clazz,
        jobjectArray arguments,
        jstring modulesPath) {

    //Set the builtin_modules path to NODE_PATH.
    const char *path_path = env->GetStringUTFChars(modulesPath, nullptr);
    setenv("NODE_PATH", path_path, 1);
    env->ReleaseStringUTFChars(modulesPath, path_path);

    //argc
    jsize argument_count = env->GetArrayLength(arguments);

    //Compute byte size need for all arguments in contiguous memory.
    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        c_arguments_size += static_cast<int>(strlen(
                env->GetStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i),
                                       nullptr)));
        c_arguments_size++; // for '\0'
    }

    //Stores arguments in contiguous memory.
    char *args_buffer = (char *) calloc(c_arguments_size, sizeof(char));

    //argv to pass into node.
    char *argv[argument_count];

    //To iterate through the expected start position of each argument in args_buffer.
    char *current_args_position = args_buffer;

    //Populate the args_buffer and argv.
    for (int i = 0; i < argument_count; i++) {
        const char *current_argument = env->GetStringUTFChars(
                (jstring) env->GetObjectArrayElement(arguments, i), nullptr);

        //Copy current argument to its expected position in args_buffer
        strncpy(current_args_position, current_argument, strlen(current_argument));

        //Save current argument start position in argv
        argv[i] = current_args_position;

        //Increment to the next argument's expected position.
        current_args_position += strlen(current_args_position) + 1;
    }

    //Start threads to show stdout and stderr in logcat.
    if (start_redirecting_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG,
                            "Couldn't start redirecting stdout and stderr to logcat.");
    }

    //Start node, with argc and argv.
    const int exit_code = node::Start(argument_count, argv);
    free(args_buffer);
    return jint(exit_code);
}
