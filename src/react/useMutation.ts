import { useState, useCallback, useRef, useEffect } from "react";

export interface UseMutationOptions<TInput, TOutput> {
  /** Called with (data, input) after a successful mutation. */
  onSuccess?: (data: TOutput, input: TInput) => void;
  /** Called with (error, input) when a mutation fails. */
  onError?: (error: Error, input: TInput) => void;
  /** Called with (data, error, input) after every mutation, success or failure. */
  onSettled?: (data: TOutput | undefined, error: Error | undefined, input: TInput) => void;
}

export interface UseMutationState<TOutput> {
  data: TOutput | undefined;
  error: Error | undefined;
  isLoading: boolean;
  called: boolean;
  reset: () => void;
}

export type UseMutationResult<TInput, TOutput> = [
  TInput extends void
    ? () => Promise<TOutput>
    : (input: TInput) => Promise<TOutput>,
  UseMutationState<TOutput>,
];

export function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options?: UseMutationOptions<TInput, TOutput>,
): UseMutationResult<TInput, TOutput> {
  const [data, setData] = useState<TOutput | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [called, setCalled] = useState(false);

  const fnRef = useRef(fn);
  const optionsRef = useRef(options);
  useEffect(() => {
    fnRef.current = fn;
    optionsRef.current = options;
  });

  const callCountRef = useRef(0);

  const reset = useCallback(() => {
    setData(undefined);
    setError(undefined);
    setIsLoading(false);
    setCalled(false);
  }, []);

  const mutate = useCallback(
    (input?: TInput): Promise<TOutput> => {
      const callId = ++callCountRef.current;
      const inputValue = input as TInput;

      setCalled(true);
      setIsLoading(true);
      setError(undefined);

      const promise = fnRef.current(inputValue);

      return promise.then(
        (result) => {
          if (callId === callCountRef.current) {
            setData(result);
            setIsLoading(false);
          }
          optionsRef.current?.onSuccess?.(result, inputValue);
          optionsRef.current?.onSettled?.(result, undefined, inputValue);
          return result;
        },
        (err: unknown) => {
          const wrappedError =
            err instanceof Error ? err : new Error(String(err));
          if (callId === callCountRef.current) {
            setError(wrappedError);
            setData(undefined);
            setIsLoading(false);
          }
          optionsRef.current?.onError?.(wrappedError, inputValue);
          optionsRef.current?.onSettled?.(undefined, wrappedError, inputValue);
          throw err;
        },
      );
    },
    [],
  );

  const state: UseMutationState<TOutput> = {
    data,
    error,
    isLoading,
    called,
    reset,
  };

  return [mutate as UseMutationResult<TInput, TOutput>[0], state];
}
