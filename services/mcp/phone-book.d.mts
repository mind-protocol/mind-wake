export function openPhoneBook(dir: string): {
  close(): void;
  invite(to: string | undefined, caller: string, label: string): unknown;
};
