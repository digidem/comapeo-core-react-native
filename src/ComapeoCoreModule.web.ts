import { registerWebModule, NativeModule } from 'expo';

import { ComapeoCoreModuleEvents } from './ComapeoCore.types';

class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
}

export default registerWebModule(ComapeoCoreModule);
