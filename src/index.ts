// Reexport the native module. On web, it will be resolved to ComapeoCoreModule.web.ts
// and on native platforms to ComapeoCoreModule.ts
export { comapeo, state, unstable_messagePort } from "./ComapeoCoreModule";
export * from "./ComapeoCore.types";
