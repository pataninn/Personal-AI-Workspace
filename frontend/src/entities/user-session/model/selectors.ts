import type { RootState } from '@/app/store/store';

export const selectSessionStatus = (state: RootState) => state.userSession.status;
export const selectPrincipal = (state: RootState) => state.userSession.principal;
export const selectCsrfToken = (state: RootState) => state.userSession.csrfToken;
export const selectSessionErrorCode = (state: RootState) => state.userSession.errorCode;
