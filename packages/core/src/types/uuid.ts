export type UUID = string & { readonly __uuid: unique symbol };

export type UUIDv7 = UUID & { readonly __uuidv7: unique symbol };
export type UUIDv4 = UUID & { readonly __uuidv4: unique symbol };
