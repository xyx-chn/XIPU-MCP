#include <node_api.h>
#include <stdint.h>

extern int32_t xipu_widget_reload(void);
extern int32_t xipu_widget_is_supported(void);

static napi_value reload(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, xipu_widget_reload() == 1, &result);
  return result;
}

static napi_value supported(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, xipu_widget_is_supported() == 1, &result);
  return result;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor properties[] = {
    {"reloadTimelines", NULL, reload, NULL, NULL, NULL, napi_default, NULL},
    {"isSupported", NULL, supported, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
