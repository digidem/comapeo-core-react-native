export type OnLoadEventPayload = {
  url: string;
};

export type ComapeoCoreModuleEvents = {
  message: (params: MessageEventPayload) => void;
  stateChange: (params: StateChangeEventPayload) => void;
};

export type MessageEventPayload = {
  data: string;
};

export type StateChangeEventPayload = {
  state: string;
};
