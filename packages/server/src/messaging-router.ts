import type { OutboundMessage, Principal } from "@open-instinct/core";
import { parseConversationKey, type FileSend, type FileSendResult, type MessagingChannel } from "@open-instinct/inkbox";

type Context = { principal: Principal; conversationKey: string };

/** Replies follow their wire conversation; new phone destinations prefer Sendblue. */
export class MessagingRouter implements MessagingChannel {
  constructor(private readonly sendblue?: MessagingChannel, private readonly inkbox?: MessagingChannel) {}
  private forChannel(channel: string, conversationKey?: string): MessagingChannel {
    const phone = channel === "imessage" || channel === "sms";
    let transport = this.inkbox;
    if (phone) {
      if (!conversationKey) transport = this.sendblue ?? this.inkbox;
      else if (parseConversationKey(conversationKey).id.startsWith("sendblue:")) transport = this.sendblue;
    }
    if (!transport) throw new Error(`No transport configured for ${conversationKey ?? channel}`);
    return transport;
  }
  send(msg: OutboundMessage, ctx: Context): Promise<void> { return this.forChannel(msg.channel, msg.to ? undefined : msg.conversationKey).send(msg, ctx); }
  sendFile(file: FileSend, ctx: Context): Promise<FileSendResult> { return this.forChannel(file.channel, file.to ? undefined : file.conversationKey).sendFile(file, ctx); }
  typing(key: string): Promise<void> { return this.forChannel(parseConversationKey(key).channel, key).typing(key); }
  react(key: string, id: string, reaction: string): Promise<void> { return this.forChannel(parseConversationKey(key).channel, key).react(key, id, reaction); }
}
