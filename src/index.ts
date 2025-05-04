// Reexport the native module. On web, it will be resolved to ComapeoCoreModule.web.ts
// and on native platforms to ComapeoCoreModule.ts
export { state, messagePort } from './ComapeoCoreModule';
export * from  './ComapeoCore.types';
