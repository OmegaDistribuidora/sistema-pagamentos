export type AppUserRole = "ADMIN" | "ANALYST" | "USER";

export type AuthUser = {
  userId: number;
  username: string;
  role: AppUserRole;
};
