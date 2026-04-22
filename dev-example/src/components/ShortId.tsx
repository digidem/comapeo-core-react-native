import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { shortId } from '@/lib/format';
import { T } from '@/lib/theme';
import { showToast } from '@/lib/toast';

type Size = 'xs' | 'sm' | 'md';

type Props = {
  id: string | undefined | null;
  label?: string;
  n?: number;
  size?: Size;
};

const SIZES: Record<Size, { fontSize: number; px: number; py: number }> = {
  xs: { fontSize: 11, px: 6, py: 2 },
  sm: { fontSize: 12, px: 7, py: 2 },
  md: { fontSize: 13, px: 8, py: 3 },
};

// Mono pill rendering shortId(id, n). Tap to copy full id, with toast confirm.
export function ShortId({ id, label = 'ID', n = 7, size = 'sm' }: Props) {
  if (!id) return null;
  const s = shortId(id, n);
  const sz = SIZES[size];

  const onPress = async () => {
    await Clipboard.setStringAsync(id);
    showToast(`Copied ${label}: ${s}…`);
  };

  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Text
        style={[
          styles.pill,
          {
            fontSize: sz.fontSize,
            paddingHorizontal: sz.px,
            paddingVertical: sz.py,
          },
        ]}
      >
        {s}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontFamily: T.mono,
    color: 'rgba(0,0,0,0.65)',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 6,
    overflow: 'hidden',
    letterSpacing: 0.2,
    alignSelf: 'flex-start',
  },
});
