export const touchTarget = {
  min: 44,
  /** RT-238: a primary commit (apply / settle) is the large control size, never below `min`. */
  commit: 56,
} as const;
