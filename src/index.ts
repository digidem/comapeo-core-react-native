// Reexport the native module. On web, it will be resolved to ComapeoCoreModule.web.ts
// and on native platforms to ComapeoCoreModule.ts
export { default } from './ComapeoCoreModule';
export { default as ComapeoCoreView } from './ComapeoCoreView';
export * from  './ComapeoCore.types';
