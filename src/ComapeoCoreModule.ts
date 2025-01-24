import { NativeModule, requireNativeModule } from 'expo';

import { ComapeoCoreModuleEvents } from './ComapeoCore.types';

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<ComapeoCoreModule>('ComapeoCore');
