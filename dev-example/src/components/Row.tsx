import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  isLast?: boolean;
  showChevron?: boolean;
  dense?: boolean;
  titleStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
};

// Tappable list row. Same structure on both platforms — only padding, dividers,
// chevron differ.
export function Row({
  leading,
  title,
  subtitle,
  right,
  onPress,
  isLast = false,
  showChevron = true,
  dense = false,
  titleStyle,
  containerStyle,
}: Props) {
  const isIos = Platform.OS === 'ios';
  const minHeight = isIos ? (dense ? 44 : 52) : 64;
  const padding = isIos ? (dense ? 8 : 12) : 12;

  const rowContent = (
    <View
      style={[
        styles.row,
        {
          minHeight,
          paddingVertical: padding,
          borderBottomColor: T.separator,
          borderBottomWidth: isLast ? 0 : T.separatorWidth,
        },
        containerStyle,
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        {typeof title === 'string' ? (
          <Text numberOfLines={1} style={[styles.title, titleStyle]}>
            {title}
          </Text>
        ) : (
          <View style={styles.titleWrap}>{title}</View>
        )}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <Text numberOfLines={2} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : (
            <View style={styles.subtitleWrap}>{subtitle}</View>
          )
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
      {onPress && showChevron && isIos ? (
        <Text style={styles.chevron}>›</Text>
      ) : null}
    </View>
  );

  if (!onPress) return rowContent;
  return (
    <Pressable android_ripple={{ color: 'rgba(0,0,0,0.06)' }} onPress={onPress}>
      {rowContent}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: Platform.select({ ios: 12, default: 16 }),
  },
  leading: {
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    color: T.text,
    fontFamily: T.font,
    letterSpacing: Platform.select({ ios: -0.3, default: 0 }),
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  subtitle: {
    fontSize: Platform.select({ ios: 13, default: 14 }),
    color: T.textMuted,
    marginTop: 2,
    fontFamily: T.font,
  },
  subtitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  right: {
    flexShrink: 0,
    marginLeft: 8,
  },
  chevron: {
    color: T.rowChevron,
    fontSize: 22,
    marginLeft: 4,
    marginTop: -2,
  },
});
