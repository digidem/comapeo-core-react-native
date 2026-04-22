// Type stub for the parent native module. The runtime resolver (Metro alias
// in metro.config.js) loads `../src/index.ts` directly, but for TS we only
// need the public surface — re-export the MapeoClientApi type from @comapeo/ipc
// so we don't pull the parent's untyped module into the project.

declare module '@comapeo/core-react-native' {
  import type { MapeoClientApi } from '@comapeo/ipc';
  export const comapeo: MapeoClientApi;
}
