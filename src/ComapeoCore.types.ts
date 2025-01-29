import type { StyleProp, ViewStyle } from 'react-native';

export type OnLoadEventPayload = {
  url: string;
};

export type ComapeoCoreModuleEvents = {
  messageReceived: (params: MessageEventPayload) => void;
};

export type MessageEventPayload = {
  data: string;
};

export type ComapeoCoreViewProps = {
  url: string;
  onLoad: (event: { nativeEvent: OnLoadEventPayload }) => void;
  style?: StyleProp<ViewStyle>;
};
