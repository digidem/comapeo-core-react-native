// Reexport the native module. On web, it will be resolved to ComapeoCoreModule.web.ts
// and on native platforms to ComapeoCoreModule.ts
export { comapeo, state } from "./ComapeoCoreModule";
export { toNativeMediaUrl } from "./mediaUrl";
export * from "./ComapeoCore.types";
