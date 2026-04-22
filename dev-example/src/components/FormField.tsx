import React from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { isHexId } from '@/lib/format';
import { T } from '@/lib/theme';

type Props = {
  label: string;
  value: string | number | undefined | null;
  onChangeText?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  multiline?: boolean;
  isLast?: boolean;
  right?: React.ReactNode;
  keyboardType?: TextInputProps['keyboardType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
};

// Platform-aware form field row. iOS: floating label above value, hairline
// separator between rows. Android: M3 label-above-underline pattern.
export function FormField({
  label,
  value,
  onChangeText,
  readOnly = false,
  placeholder = '—',
  multiline = false,
  isLast = false,
  right,
  keyboardType,
  autoCapitalize,
}: Props) {
  const isIos = Platform.OS === 'ios';
  const stringValue = value == null ? '' : String(value);
  const editable = !!onChangeText && !readOnly;
  const fontFamily = isHexId(stringValue) ? T.mono : T.font;

  return (
    <View
      style={[
        styles.wrapper,
        isIos && {
          borderBottomColor: T.separator,
          borderBottomWidth: isLast ? 0 : T.separatorWidth,
        },
      ]}
    >
      <View style={styles.labelRow}>
        <Text style={[styles.label, readOnly && styles.labelReadOnly]}>{label}</Text>
        {readOnly ? <Text style={styles.readOnlyTag}>READ-ONLY</Text> : null}
      </View>
      <View style={styles.valueRow}>
        {editable ? (
          <TextInput
            style={[
              styles.input,
              { fontFamily },
              !isIos && styles.androidUnderline,
              multiline && styles.multiline,
            ]}
            value={stringValue}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={T.textReadOnly}
            multiline={multiline}
            keyboardType={keyboardType}
            autoCapitalize={autoCapitalize}
          />
        ) : (
          <View
            style={[
              !isIos && styles.androidUnderline,
              !isIos && readOnly && styles.androidUnderlineReadOnly,
              styles.staticValueWrap,
            ]}
          >
            <Text
              style={[
                styles.staticValue,
                { fontFamily },
                readOnly && styles.staticValueReadOnly,
                multiline && styles.multilineStatic,
              ]}
            >
              {stringValue || <Text style={styles.placeholder}>{placeholder}</Text>}
            </Text>
          </View>
        )}
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 16,
    paddingVertical: Platform.select({ ios: 10, default: 12 }),
    gap: 4,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
    color: T.textLabel,
    letterSpacing: Platform.select({ ios: -0.08, default: 0.4 }),
  },
  labelReadOnly: {
    color: T.textReadOnly,
  },
  readOnlyTag: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: T.textReadOnly,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: T.text,
    paddingVertical: Platform.select({ ios: 0, default: 4 }),
    minHeight: 22,
  },
  multiline: {
    minHeight: 60,
    textAlignVertical: 'top',
    fontSize: 15,
  },
  staticValueWrap: {
    flex: 1,
    minHeight: 22,
    justifyContent: 'center',
  },
  staticValue: {
    fontSize: 16,
    color: T.text,
  },
  staticValueReadOnly: {
    color: T.textMuted,
  },
  multilineStatic: {
    fontSize: 15,
  },
  androidUnderline: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(23,29,27,0.4)',
    paddingBottom: 6,
  },
  androidUnderlineReadOnly: {
    borderBottomColor: 'rgba(23,29,27,0.15)',
    borderStyle: 'dashed',
  },
  placeholder: {
    color: T.textReadOnly,
  },
  right: {
    flexShrink: 0,
  },
});
