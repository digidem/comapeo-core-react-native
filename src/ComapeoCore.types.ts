export type OnLoadEventPayload = {
  url: string;
};

export type ComapeoCoreModuleEvents = {
  message: (params: MessageEventPayload) => void;
};

export type MessageEventPayload = {
  data: string;
};
