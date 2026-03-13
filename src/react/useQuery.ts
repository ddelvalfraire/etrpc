import { useState, useEffect, useCallback, useRef } from "react";

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "onSuccess",
  "onError",
  "onSettled",
  "initialData",
  "keepPreviousData",
  "select",
]);

export interface UseQueryOptions<TOutput = unknown, TSelected = TOutput> {
  /** If false, the query will not execute. Defaults to true. */
  enabled?: boolean;
  /** Called with the data when the query succeeds. */
  onSuccess?: (data: TSelected) => void;
  /** Called with the error when the query fails. */
  onError?: (error: Error) => void;
  /** Called after every fetch, whether it succeeds or fails. */
  onSettled?: (data: TSelected | undefined, error: Error | undefined) => void;
  /** Default data to use before the first fetch completes. */
  initialData?: TOutput;
  /** If true, keeps the previous data while refetching with new input. */
  keepPreviousData?: boolean;
  /** Transform the raw query data before setting state. */
  select?: (data: TOutput) => TSelected;
}

export interface UseQueryResult<TOutput> {
  data: TOutput | undefined;
  error: Error | undefined;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

// Overload: void-input query (no args)
export function useQuery<TOutput, TSelected = TOutput>(
  fn: () => Promise<TOutput>,
  options?: UseQueryOptions<TOutput, TSelected>,
): UseQueryResult<TSelected>;

// Overload: typed-input query (with args)
export function useQuery<TInput, TOutput, TSelected = TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  input: TInput,
  options?: UseQueryOptions<TOutput, TSelected>,
): UseQueryResult<TSelected>;

export function useQuery<TInput, TOutput, TSelected = TOutput>(
  fn: (input?: TInput) => Promise<TOutput>,
  inputOrOptions?: TInput | UseQueryOptions<TOutput, TSelected>,
  maybeOptions?: UseQueryOptions<TOutput, TSelected>,
): UseQueryResult<TSelected> {
  const isOptionsObject = (val: unknown): val is UseQueryOptions<TOutput, TSelected> => {
    if (val === null || val === undefined) return false;
    if (typeof val !== "object") return false;
    const keys = Object.keys(val as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => OPTION_KEYS.has(k));
  };

  const isVoidInput =
    inputOrOptions === undefined || isOptionsObject(inputOrOptions);

  const input: TInput | undefined = isVoidInput
    ? undefined
    : (inputOrOptions as TInput);

  const options: UseQueryOptions<TOutput, TSelected> | undefined = isVoidInput
    ? (inputOrOptions as UseQueryOptions<TOutput, TSelected> | undefined)
    : maybeOptions;

  const enabled = options?.enabled !== false;
  const keepPreviousData = options?.keepPreviousData === true;
  const selectFn = options?.select;

  const [data, setData] = useState<TSelected | undefined>(
    options?.initialData !== undefined
      ? (selectFn ? selectFn(options.initialData) : options.initialData as unknown as TSelected)
      : undefined,
  );
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);

  const serializedInput = isVoidInput ? "___void___" : JSON.stringify(input);

  const requestIdRef = useRef(0);
  const hasRunRef = useRef(false);

  const fnRef = useRef(fn);
  const inputRef = useRef(input);
  const isVoidInputRef = useRef(isVoidInput);
  const optionsRef = useRef(options);
  const selectRef = useRef(selectFn);

  useEffect(() => {
    fnRef.current = fn;
    inputRef.current = input;
    isVoidInputRef.current = isVoidInput;
    optionsRef.current = options;
    selectRef.current = selectFn;
  });

  const applySelect = useCallback((raw: TOutput): { ok: true; value: TSelected } | { ok: false; error: Error } => {
    const sel = selectRef.current;
    if (!sel) {
      return { ok: true, value: raw as unknown as TSelected };
    }
    try {
      return { ok: true, value: sel(raw) };
    } catch (err: unknown) {
      const wrappedError = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error: wrappedError };
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    const id = ++requestIdRef.current;

    if (hasRunRef.current && !keepPreviousData) {
      setData(undefined);
    }
    hasRunRef.current = true;
    setIsLoading(true);
    setError(undefined);
    const promise = isVoidInput
      ? (fn as () => Promise<TOutput>)()
      : fn(input);

    promise.then(
      (result) => {
        if (requestIdRef.current !== id) return;
        const transformed = applySelect(result);
        if (transformed.ok) {
          setData(transformed.value);
          setIsLoading(false);
          optionsRef.current?.onSuccess?.(transformed.value);
          optionsRef.current?.onSettled?.(transformed.value, undefined);
        } else {
          setError(transformed.error);
          setIsLoading(false);
          optionsRef.current?.onError?.(transformed.error);
          optionsRef.current?.onSettled?.(undefined, transformed.error);
        }
      },
      (err: unknown) => {
        if (requestIdRef.current !== id) return;
        const wrappedError =
          err instanceof Error ? err : new Error(String(err));
        setError(wrappedError);
        setIsLoading(false);
        optionsRef.current?.onError?.(wrappedError);
        optionsRef.current?.onSettled?.(undefined, wrappedError);
      },
    );

    return () => {
      // Bumping requestIdRef invalidates the in-flight fetch for this effect run.
      // This also correctly invalidates any overlapping refetch() calls.
      requestIdRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedInput, enabled, applySelect]);

  const refetch = useCallback((): Promise<void> => {
    const id = ++requestIdRef.current;

    setIsLoading(true);
    setError(undefined);

    const promise = isVoidInputRef.current
      ? (fnRef.current as () => Promise<TOutput>)()
      : fnRef.current(inputRef.current);

    return promise.then(
      (result) => {
        if (requestIdRef.current !== id) return;
        const transformed = applySelect(result);
        if (transformed.ok) {
          setData(transformed.value);
          setIsLoading(false);
          optionsRef.current?.onSuccess?.(transformed.value);
          optionsRef.current?.onSettled?.(transformed.value, undefined);
        } else {
          setError(transformed.error);
          setIsLoading(false);
          optionsRef.current?.onError?.(transformed.error);
          optionsRef.current?.onSettled?.(undefined, transformed.error);
        }
      },
      (err: unknown) => {
        if (requestIdRef.current !== id) return;
        const wrappedError =
          err instanceof Error ? err : new Error(String(err));
        setError(wrappedError);
        setIsLoading(false);
        optionsRef.current?.onError?.(wrappedError);
        optionsRef.current?.onSettled?.(undefined, wrappedError);
      },
    );
  }, [applySelect]);

  return { data, error, isLoading, refetch };
}
