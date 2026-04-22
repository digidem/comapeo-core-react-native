import { presetInitial } from '@/lib/format';

import { Glyph } from './Glyph';

type Props = {
  name: string | undefined;
  color?: string;
  size?: number;
};

export function PresetIcon({ name, color = '#0E6B52', size = 32 }: Props) {
  return <Glyph bg={color} ch={presetInitial(name)} size={size} />;
}
