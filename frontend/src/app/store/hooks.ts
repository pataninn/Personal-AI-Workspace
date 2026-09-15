import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch, RootState } from '@/app/store/store';

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector = <T>(selector: (state: RootState) => T): T => useSelector(selector);
