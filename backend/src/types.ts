export type AppUserRole = "ADMIN" | "USER";

export type AuthUser = {
  userId: number;
  username: string;
  role: AppUserRole;
};
