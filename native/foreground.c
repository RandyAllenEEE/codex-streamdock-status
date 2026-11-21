#include <windows.h>
#include <appmodel.h>
#include <node_api.h>
#include <stdlib.h>
#include <wchar.h>

// Resolve Node-API from the process hosting the addon. MiraBox names
// its embedded runtime node20.exe, while upstream Node uses node.exe.
#define HOST_API(X) \
    X(napi_add_env_cleanup_hook) \
    X(napi_remove_env_cleanup_hook) \
    X(napi_call_threadsafe_function) \
    X(napi_create_string_utf8) \
    X(napi_create_threadsafe_function) \
    X(napi_define_properties) \
    X(napi_get_boolean) \
    X(napi_get_cb_info) \
    X(napi_get_undefined) \
    X(napi_release_threadsafe_function) \
    X(napi_throw_error) \
    X(napi_typeof) \
    X(napi_unref_threadsafe_function)

#define DECLARE_API(name) static __typeof__(&name) host_##name;
HOST_API(DECLARE_API)
#undef DECLARE_API

typedef struct {
    HANDLE ready;
    HANDLE stop;
    HANDLE thread;
    BOOL started;
    BOOL was_codex;
    BOOL cleanup_registered;
    napi_threadsafe_function callback;
} ForegroundWatch;

static _Thread_local ForegroundWatch *current_watch;

static BOOL is_codex(HWND window)
{
    DWORD pid = 0;
    if (!window || !GetWindowThreadProcessId(window, &pid)) return FALSE;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return FALSE;
    WCHAR family[128];
    UINT32 length = ARRAYSIZE(family);
    LONG status = GetPackageFamilyName(process, &length, family);
    CloseHandle(process);
    return status == ERROR_SUCCESS && wcsncmp(family, L"OpenAI.Codex_", 13) == 0;
}

static void CALLBACK foreground_changed(HWINEVENTHOOK hook, DWORD event, HWND window,
    LONG object, LONG child, DWORD thread, DWORD time)
{
    ForegroundWatch *watch = current_watch;
    if (!watch || object != OBJID_WINDOW || child != CHILDID_SELF) return;
    BOOL codex = is_codex(window);
    BOOL entered = codex && !watch->was_codex;
    watch->was_codex = codex;
    if (entered) host_napi_call_threadsafe_function(watch->callback, NULL, napi_tsfn_nonblocking);
}

static DWORD WINAPI watch_foreground(void *data)
{
    ForegroundWatch *watch = data;
    current_watch = watch;
    MSG message;
    PeekMessageW(&message, NULL, 0, 0, PM_NOREMOVE);
    HWINEVENTHOOK hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
        NULL, foreground_changed, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    watch->started = hook != NULL;
    watch->was_codex = is_codex(GetForegroundWindow());
    SetEvent(watch->ready);
    if (hook) {
        while (MsgWaitForMultipleObjects(1, &watch->stop, FALSE, INFINITE, QS_ALLINPUT) == WAIT_OBJECT_0 + 1) {
            while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        UnhookWinEvent(hook);
    }
    current_watch = NULL;
    return 0;
}

static void stop_watch(ForegroundWatch *watch)
{
    if (watch->thread) {
        SetEvent(watch->stop);
        WaitForSingleObject(watch->thread, INFINITE);
        CloseHandle(watch->thread);
        watch->thread = NULL;
    }
    if (watch->callback) {
        host_napi_release_threadsafe_function(watch->callback, napi_tsfn_abort);
        watch->callback = NULL;
    }
    if (watch->ready) CloseHandle(watch->ready);
    if (watch->stop) CloseHandle(watch->stop);
    watch->ready = NULL;
    watch->stop = NULL;
}

static void stop_before_exit(void *data)
{
    ForegroundWatch *watch = data;
    watch->cleanup_registered = FALSE;
    stop_watch(watch);
}

static void stop_active(napi_env env, ForegroundWatch *watch)
{
    if (watch->cleanup_registered) {
        host_napi_remove_env_cleanup_hook(env, stop_before_exit, watch);
        watch->cleanup_registered = FALSE;
    }
    stop_watch(watch);
}

static napi_value fail(napi_env env, const char *message)
{
    host_napi_throw_error(env, NULL, message);
    return NULL;
}

static napi_value start(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value callback;
    void *data;
    napi_valuetype type;
    if (host_napi_get_cb_info(env, info, &argc, &callback, NULL, &data) != napi_ok ||
        argc != 1 || host_napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
        return fail(env, "Expected a foreground listener callback.");
    }
    ForegroundWatch *watch = data;
    if (watch->thread) return fail(env, "Foreground listener is already active.");
    napi_value name;
    if (host_napi_create_string_utf8(env, "Codex foreground", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        host_napi_create_threadsafe_function(env, callback, NULL, name, 8, 1,
            NULL, NULL, NULL, NULL, &watch->callback) != napi_ok) {
        return fail(env, "Unable to create the foreground callback.");
    }
    // This hook is registered after the thread-safe function so teardown
    // joins the worker before Node cleans up the function.
    if (host_napi_add_env_cleanup_hook(env, stop_before_exit, watch) != napi_ok) {
        stop_watch(watch);
        return fail(env, "Unable to register foreground cleanup.");
    }
    watch->cleanup_registered = TRUE;
    if (host_napi_unref_threadsafe_function(env, watch->callback) != napi_ok) {
        stop_active(env, watch);
        return fail(env, "Unable to unref the foreground callback.");
    }
    watch->ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    watch->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (watch->ready && watch->stop) {
        watch->thread = CreateThread(NULL, 0, watch_foreground, watch, 0, NULL);
    }
    if (!watch->thread || WaitForSingleObject(watch->ready, INFINITE) != WAIT_OBJECT_0 || !watch->started) {
        stop_active(env, watch);
        return fail(env, "Unable to register the Windows foreground event.");
    }
    napi_value result;
    host_napi_get_undefined(env, &result);
    return result;
}

static napi_value stop(napi_env env, napi_callback_info info)
{
    void *data;
    host_napi_get_cb_info(env, info, NULL, NULL, NULL, &data);
    stop_active(env, data);
    napi_value result;
    host_napi_get_undefined(env, &result);
    return result;
}

static napi_value foreground(napi_env env, napi_callback_info info)
{
    napi_value result;
    host_napi_get_boolean(env, is_codex(GetForegroundWindow()), &result);
    return result;
}

NAPI_MODULE_INIT()
{
    HMODULE host = GetModuleHandleW(NULL);
#define LOAD_API(name) host_##name = (__typeof__(&name))GetProcAddress(host, #name); if (!host_##name) return NULL;
    HOST_API(LOAD_API)
#undef LOAD_API
    ForegroundWatch *watch = calloc(1, sizeof(*watch));
    if (!watch) return fail(env, "Unable to allocate foreground listener state.");
    if (host_napi_add_env_cleanup_hook(env, free, watch) != napi_ok) {
        free(watch);
        return fail(env, "Unable to register foreground cleanup.");
    }
    const napi_property_descriptor properties[] = {
        { .utf8name = "start", .method = start, .data = watch },
        { .utf8name = "stop", .method = stop, .data = watch },
        { .utf8name = "isCodexForeground", .method = foreground },
    };
    if (host_napi_define_properties(env, exports, ARRAYSIZE(properties), properties) != napi_ok) {
        host_napi_remove_env_cleanup_hook(env, free, watch);
        free(watch);
        return fail(env, "Unable to export the foreground listener.");
    }
    return exports;
}
