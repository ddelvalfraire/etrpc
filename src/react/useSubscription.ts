import { useState, useEffect, useRef } from "react";
import type { UnsubscribeFn, SubscriptionOptions } from "../shared/types";

export interface UseSubscriptionOptions<TOutput> {
  enabled?: boolean;
  onData?: (data: TOutput) => void;
  onError?: (error: Error) => void;
}

export interface UseSubscriptionResult<TOutput> {
  data: TOutput | undefined;
  error: Error | undefined;
  status: "idle" | "loading" | "active" | "error";
}

// Overload: void-input subscription
export function useSubscription<TOutput>(
  fn: (options: SubscriptionOptions<TOutput>) => UnsubscribeFn,
  options?: UseSubscriptionOptions<TOutput>,
): UseSubscriptionResult<TOutput>;

// Overload: typed-input subscription
export function useSubscription<TInput, TOutput>(
  fn: (input: TInput, options: SubscriptionOptions<TOutput>) => UnsubscribeFn,
  input: TInput,
  options?: UseSubscriptionOptions<TOutput>,
): UseSubscriptionResult<TOutput>;

export function useSubscription<TInput, TOutput>(
  fn: ((options: SubscriptionOptions<TOutput>) => UnsubscribeFn) |
      ((input: TInput, options: SubscriptionOptions<TOutput>) => UnsubscribeFn),
  inputOrOptions?: TInput | UseSubscriptionOptions<TOutput>,
  maybeOptions?: UseSubscriptionOptions<TOutput>,
): UseSubscriptionResult<TOutput> {
  const isOptions = (val: unknown): val is UseSubscriptionOptions<TOutput> => {
    if (val === undefined || val === null) return true;
    if (typeof val !== "object") return false;
    const keys = Object.keys(val as Record<string, unknown>);
    return keys.length === 0 || keys.every(
      (k) => k === "enabled" || k === "onData" || k === "onError",
    );
  };

  let input: TInput | undefined;
  let options: UseSubscriptionOptions<TOutput> | undefined;

  if (maybeOptions !== undefined) {
    input = inputOrOptions as TInput;
    options = maybeOptions;
  } else if (isOptions(inputOrOptions)) {
    input = undefined;
    options = inputOrOptions;
  } else {
    input = inputOrOptions as TInput;
    options = undefined;
  }

  const enabled = options?.enabled ?? true;
  const isVoidInput = input === undefined;
  const serializedInput = JSON.stringify(input);

  const [data, setData] = useState<TOutput | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [status, setStatus] = useState<"idle" | "loading" | "active" | "error">(
    enabled ? "loading" : "idle",
  );

  const fnRef = useRef(fn);
  const optionsRef = useRef(options);
  const inputRef = useRef(input);
  const isVoidInputRef = useRef(isVoidInput);

  useEffect(() => {
    fnRef.current = fn;
    optionsRef.current = options;
    inputRef.current = input;
    isVoidInputRef.current = isVoidInput;
  });

  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setError(undefined);
      setStatus("idle");
      return;
    }

    setData(undefined);
    setError(undefined);
    setStatus("loading");

    let isUnsubscribed = false;

    const currentFn = fnRef.current;
    const currentInput = inputRef.current;
    const currentIsVoidInput = isVoidInputRef.current;

    const subscriptionOptions: SubscriptionOptions<TOutput> = {
      onData: (value: TOutput) => {
        if (isUnsubscribed) return;
        setData(value);
        setStatus("active");
        optionsRef.current?.onData?.(value);
      },
      onError: (err: Error) => {
        if (isUnsubscribed) return;
        setError(err);
        setStatus("error");
        optionsRef.current?.onError?.(err);
      },
    };

    let unsubscribe: UnsubscribeFn;
    if (currentIsVoidInput) {
      unsubscribe = (currentFn as (options: SubscriptionOptions<TOutput>) => UnsubscribeFn)(
        subscriptionOptions,
      );
    } else {
      unsubscribe = (currentFn as (input: TInput, options: SubscriptionOptions<TOutput>) => UnsubscribeFn)(
        currentInput as TInput,
        subscriptionOptions,
      );
    }

    return () => {
      isUnsubscribed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedInput, enabled]);

  return { data, error, status };
}
