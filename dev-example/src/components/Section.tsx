import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  header?: string;
  footer?: string;
  children: React.ReactNode;
};

// Groups rows. iOS = inset rounded card, Android = edge-to-edge with header label.
export function Section({ header, footer, children }: Props) {
  return (
    <View style={styles.wrapper}>
      {header ? <Text style={styles.header}>{Platform.OS === 'ios' ? header.toUpperCase() : header}</Text> : null}
      <View style={styles.card}>{children}</View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: Platform.select({ ios: 24, default: 8 }),
  },
  header: {
    fontSize: T.sectionLabelFontSize,
    color: T.sectionLabelColor,
    fontWeight: Platform.select({ ios: '400', default: '500' }),
    paddingHorizontal: Platform.select({ ios: 32, default: 16 }),
    paddingTop: Platform.select({ ios: 16, default: 24 }),
    paddingBottom: Platform.select({ ios: 6, default: 8 }),
    letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
  },
  card: {
    backgroundColor: T.card,
    borderRadius: T.cardRadius,
    marginHorizontal: T.cardInsetH,
    overflow: 'hidden',
  },
  footer: {
    fontSize: 13,
    color: T.textMuted,
    paddingHorizontal: Platform.select({ ios: 32, default: 16 }),
    paddingTop: 6,
  },
});
