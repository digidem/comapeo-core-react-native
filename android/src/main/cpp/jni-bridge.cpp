#include <fbjni/fbjni.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <string>
#include <vector>
#include <android/log.h>

#include "node.h"
#include "log.h"

using namespace facebook::jni;

// Start threads to redirect stdout and stderr to logcat.
int pipe_stdout[2];
int pipe_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;
bool thread_stdout_created = false;
bool thread_stderr_created = false;

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
    // set stdout as unbuffered.
    setvbuf(stdout, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    // set stderr as unbuffered.
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if (pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr) != 0)
        return -1;
    thread_stdout_created = true;

    if (pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr) != 0)
        return -1;
    thread_stderr_created = true;

    return 0;
}

void stop_redirecting_stdout_stderr() {
    // Close all write-end refs (STDOUT_FILENO is a dup2 alias of pipe_stdout[1]) so
    // the pumps see EOF, then join so the buffer drains before JNI returns. The
    // _created flags guard against pthread_join on an uninitialized handle when
    // pthread_create failed in start_redirecting_stdout_stderr.
    close(STDOUT_FILENO);
    close(pipe_stdout[1]);
    close(STDERR_FILENO);
    close(pipe_stderr[1]);
    if (thread_stdout_created) {
        pthread_join(thread_stdout, nullptr);
        thread_stdout_created = false;
    }
    if (thread_stderr_created) {
        pthread_join(thread_stderr, nullptr);
        thread_stderr_created = false;
    }
    close(pipe_stdout[0]);
    close(pipe_stderr[0]);
}

class NodeJSService : public JavaClass<NodeJSService> {
public:
    static constexpr auto kJavaDescriptor = "Lcom/comapeo/core/NodeJSService;";

    static void initialize(alias_ref<JClass>, alias_ref<jstring> dataDir) {
        auto nativeDataDir = dataDir->toStdString();
        log("initialize: %s", nativeDataDir.c_str());
    }

    static jint startNodeWithArguments(alias_ref<JClass>,
                                       alias_ref<JArrayClass<jstring>> arguments) {
        log("Starting NodeJS with arguments.");

        // Convert Java string array to char* array for Node.js
        // node's libUV requires all arguments being on contiguous memory.
        size_t size = arguments->size();
        std::vector<std::string> argStrings;
        argStrings.reserve(size);
        for (size_t i = 0; i < size; i++) {
            argStrings.push_back(arguments->getElement(i)->toStdString());
        }

        // Take c_str() pointers only after argStrings stops growing: a realloc
        // moves SSO strings, dangling any char* captured mid-fill.
        std::vector<char *> argv;
        argv.reserve(size);
        for (auto &arg : argStrings) {
            argv.push_back(const_cast<char *>(arg.c_str()));
        }

        log("about to start redirection");

        // Start threads to show stdout and stderr in logcat.
        if (start_redirecting_stdout_stderr() == -1) {
            __android_log_write(ANDROID_LOG_ERROR, ADBTAG,
                                "Couldn't start redirecting stdout and stderr to logcat.");
        }

        log("about to start node");

        // Start node, with argc and argv.
        const int exit_code = node::Start(argv.size(), argv.data());

        // Clean up redirection.
        stop_redirecting_stdout_stderr();

        return exit_code;
    }

    static void registerNatives() {
        javaClassStatic()->registerNatives({
                                                   makeNativeMethod("initialize",
                                                                    NodeJSService::initialize),
                                                   makeNativeMethod("startNodeWithArguments",
                                                                    NodeJSService::startNodeWithArguments),
                                           });
    }
};

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    return facebook::jni::initialize(vm, [] { NodeJSService::registerNatives(); });
}
