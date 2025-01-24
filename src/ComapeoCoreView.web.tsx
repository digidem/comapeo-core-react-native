import * as React from 'react';

import { ComapeoCoreViewProps } from './ComapeoCore.types';

export default function ComapeoCoreView(props: ComapeoCoreViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
