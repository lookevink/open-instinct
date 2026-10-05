import type { OutboundMessage, Principal } from "@open-instinct/core";
import { parseConversationKey, type FileSend, type FileSendResult, type InkboxChannel, type MessagingChannel } from "@open-instinct/inkbox";
import type { SendblueChannel } from "@open-instinct/sendblue";

type Context = { principal: Principal; conversationKey: string };

/** Sendblue owns phone delivery when configured; Inkbox still owns email and A2A. */
export class MessagingRouter implements MessagingChannel {
  constructor(private readonly sendblue?: SendblueChannel, private readonly inkbox?: InkboxChannel) {}
  private forChannel(channel: string): MessagingChannel {
    if ((channel === "imessage" || channel === "sms") && this.sendblue) return this.sendblue;
    if (this.inkbox) return this.inkbox;
    throw new Error(`No transport configured for ${channel}`);
  }
  send(msg: OutboundMessage, ctx: Context): Promise<void> { return this.forChannel(msg.channel).send(msg, ctx); }
  sendFile(file: FileSend, ctx: Context): Promise<FileSendResult> { return this.forChannel(file.channel).sendFile(file, ctx); }
  typing(key: string): Promise<void> { return this.forChannel(parseConversationKey(key).channel).typing(key); }
  react(key: string, id: string, reaction: string): Promise<void> { return this.forChannel(parseConversationKey(key).channel).react(key, id, reaction); }
}
