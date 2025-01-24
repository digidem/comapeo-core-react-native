import { requireNativeView } from 'expo';
import * as React from 'react';

import { ComapeoCoreViewProps } from './ComapeoCore.types';

const NativeView: React.ComponentType<ComapeoCoreViewProps> =
  requireNativeView('ComapeoCore');

export default function ComapeoCoreView(props: ComapeoCoreViewProps) {
  return <NativeView {...props} />;
}
