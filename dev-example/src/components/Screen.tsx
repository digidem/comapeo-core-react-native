import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  children: React.ReactNode;
  contentContainerStyle?: ViewStyle;
  scroll?: boolean;
};

// A consistent screen wrapper: platform background, vertical scroll by default,
// extra bottom padding to keep content above any FAB.
export function Screen({ children, contentContainerStyle, scroll = true }: Props) {
  if (!scroll) {
    return <View style={[styles.root]}>{children}</View>;
  }
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, contentContainerStyle]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: T.bg,
  },
  content: {
    paddingBottom: 96,
  },
});
