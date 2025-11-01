export interface PromptItem {
  text: string;
  weight: number;
}

export interface PromptTransition {
  target_prompts: PromptItem[];
  num_steps?: number; // Default: 4
  temporal_interpolation_method?: "linear" | "slerp"; // Default: linear
}

export interface PipelineParameterUpdate {
  prompts?: string[] | PromptItem[];
  prompt_interpolation_method?: "linear" | "slerp";
  transition?: PromptTransition;
  denoising_step_list?: number[];
  noise_scale?: number;
  noise_controller?: boolean;
  manage_cache?: boolean;
  reset_cache?: boolean;
  paused?: boolean;
}

export interface LivepeerStreamStartRequest {
  initialParameters?: PipelineParameterUpdate;
}

export interface LivepeerStreamStartResponse {
  whep_url: string;
  stream_id: string;
  [key: string]: unknown;
}

let livepeerStreamId: string | null = null;

export const setLivepeerStreamId = (id: string | null) => {
  livepeerStreamId = id;
};

async function withLivepeerRoute<T>(
  route: string,
  requestBody: unknown,
  fetcher: () => Promise<T>
): Promise<T> {
  if (livepeerStreamId) {
    const result = await forwardLivepeerRequest(
      livepeerStreamId,
      route,
      requestBody ?? null
    );
    return result as T;
  }

  return fetcher();
}

export interface WebRTCOfferRequest {
  sdp?: string;
  type?: string;
  initialParameters?: PipelineParameterUpdate;
}

export interface PipelineLoadParams {
  // Base interface for pipeline load parameters
  [key: string]: unknown;
}

export interface PassthroughLoadParams extends PipelineLoadParams {
  height?: number;
  width?: number;
}

export interface LongLiveLoadParams extends PipelineLoadParams {
  height?: number;
  width?: number;
  seed?: number;
}

export interface KreaRealtimeVideoLoadParams extends PipelineLoadParams {
  height?: number;
  width?: number;
  seed?: number;
  quantization?: "fp8_e4m3fn" | null;
}

export interface PipelineLoadRequest {
  pipeline_id?: string;
  load_params?:
    | PassthroughLoadParams
    | LongLiveLoadParams
    | KreaRealtimeVideoLoadParams
    | null;
}

export interface PipelineStatusResponse {
  status: "not_loaded" | "loading" | "loaded" | "error";
  pipeline_id?: string;
  load_params?: Record<string, unknown>;
  error?: string;
}

export const sendWebRTCOffer = async (
  data: WebRTCOfferRequest
): Promise<RTCSessionDescriptionInit> =>
  withLivepeerRoute("/api/v1/webrtc/offer", data, async () => {
    const response = await fetch("/api/v1/webrtc/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `WebRTC offer failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });

export const loadPipeline = async (
  data: PipelineLoadRequest = {}
): Promise<{ message: string }> =>
  withLivepeerRoute("/api/v1/pipeline/load", data, async () => {
    const response = await fetch("/api/v1/pipeline/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Pipeline load failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });

export const getPipelineStatus = async (): Promise<PipelineStatusResponse> => {
  return withLivepeerRoute("/api/v1/pipeline/status", null, async () => {
    const response = await fetch("/api/v1/pipeline/status", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Pipeline status failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });
};

export const checkModelStatus = async (
  pipelineId: string
): Promise<{ downloaded: boolean }> =>
  withLivepeerRoute(
    `/api/v1/models/status?pipeline_id=${pipelineId}`,
    null,
    async () => {
      const response = await fetch(
        `/api/v1/models/status?pipeline_id=${pipelineId}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Model status check failed: ${response.status} ${response.statusText}: ${errorText}`
        );
      }

      const result = await response.json();
      return result;
    }
  );

export const downloadPipelineModels = async (
  pipelineId: string
): Promise<{ message: string }> =>
  withLivepeerRoute("/api/v1/models/download", { pipeline_id: pipelineId }, async () => {
    const response = await fetch("/api/v1/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline_id: pipelineId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Model download failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });

export const updatePipelineParameters = async (
  data: PipelineParameterUpdate
): Promise<{ message: string }> =>
  withLivepeerRoute("/api/v1/pipeline/update", data, async () => {
    const response = await fetch("/api/v1/pipeline/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Pipeline update failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });

export const startLivepeerStream = async (
  data: LivepeerStreamStartRequest = {}
): Promise<LivepeerStreamStartResponse> => {
  const response = await fetch("/ai/stream/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Livepeer stream start failed: ${response.status} ${response.statusText}: ${errorText}`
    );
  }

  const result = (await response.json()) as LivepeerStreamStartResponse;

  if (!result?.whep_url) {
    throw new Error("Livepeer stream start response missing whep_url");
  }

  if (!result?.stream_id) {
    throw new Error("Livepeer stream start response missing stream_id");
  }

  return result;
};

export async function forwardLivepeerRequest(
  streamId: string,
  route: string,
  payload: unknown
): Promise<unknown> {
  const response = await fetch(`/ai/stream/${encodeURIComponent(streamId)}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      route,
      request: payload,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Livepeer update failed: ${response.status} ${response.statusText}: ${errorText}`
    );
  }

  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    // Return raw text if response is not JSON
    return responseText;
  }
}

export interface HardwareInfoResponse {
  vram_gb: number | null;
}

export const getHardwareInfo = async (): Promise<HardwareInfoResponse> =>
  withLivepeerRoute("/api/v1/hardware/info", null, async () => {
    const response = await fetch("/api/v1/hardware/info", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Hardware info failed: ${response.status} ${response.statusText}: ${errorText}`
      );
    }

    const result = await response.json();
    return result;
  });
