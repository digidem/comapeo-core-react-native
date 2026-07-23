// Reexport the native module. On web, it will be resolved to ComapeoCoreModule.web.ts
// and on native platforms to ComapeoCoreModule.ts
export {
  comapeo,
  state,
  comapeoServicesClient,
  getNotificationPermissionsAsync,
  requestNotificationPermissionsAsync,
} from "./ComapeoCoreModule.js";
export * from "./ComapeoCore.types.js";
