export interface GenerateConnectLinkResponse {
  url: string;
  expiresAt: string;
}

export interface CheckBindingResponse {
  bound: boolean;
  chatId?: string;
}
