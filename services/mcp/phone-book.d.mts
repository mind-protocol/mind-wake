export function openPhoneBook(dir: string): {
  close(): void;
  invite(to: string | undefined, caller: string, label: string, options?: {inviteHumans?:boolean;callId?:string|null}): unknown;
};
