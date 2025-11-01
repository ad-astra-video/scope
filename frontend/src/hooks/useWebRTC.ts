import { useState, useEffect, useRef, useCallback } from "react";
import {
  sendWebRTCOffer,
  type PipelineParameterUpdate,
  updatePipelineParameters,
  startLivepeerStream,
  setLivepeerStreamId,
} from "../lib/api";
import { toast } from "sonner";

type InitialParameters = PipelineParameterUpdate;

interface UseWebRTCOptions {
  /** Callback function called when the stream stops on the backend */
  onStreamStop?: () => void;
  /** Delivery mechanism for parameter updates */
  parameterTransport?: "webrtc" | "livepeer";
}

/**
 * Hook for managing WebRTC connections and streaming.
 *
 * Automatically handles stream stop notifications from the backend
 * and updates the UI state accordingly.
 */
export function useWebRTC(options?: UseWebRTCOptions) {
  const onStreamStop = options?.onStreamStop;
  const parameterTransport = options?.parameterTransport ?? "webrtc";

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>("new");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const currentStreamRef = useRef<MediaStream | null>(null);
  const livepeerStreamIdRef = useRef<string | null>(null);

  const startStream = useCallback(
    async (initialParameters?: InitialParameters, stream?: MediaStream) => {
      if (isConnecting || peerConnectionRef.current) return;

      setIsConnecting(true);

      try {
        if (parameterTransport !== "livepeer") {
          livepeerStreamIdRef.current = null;
          setLivepeerStreamId(null);
        }

        currentStreamRef.current = stream || null;

        // Create peer connection
        const config: RTCConfiguration = {
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        };

        const pc = new RTCPeerConnection(config);
        peerConnectionRef.current = pc;

        const isLivepeerTransport = parameterTransport === "livepeer";
        let whepUrl: string | null = null;

        if (!isLivepeerTransport) {
          // Create data channel for parameter updates
          const dataChannel = pc.createDataChannel("parameters", {
            ordered: true,
          });
          dataChannelRef.current = dataChannel;

          dataChannel.onopen = () => {
            console.log("Data channel opened");
          };

          dataChannel.onmessage = event => {
            console.log("Data channel message received:", event.data);

            try {
              const data = JSON.parse(event.data);

              // Handle stream stop notification from backend
              if (data.type === "stream_stopped") {
                console.log("Stream stopped by backend, updating UI");
                setIsStreaming(false);
                setIsConnecting(false);
                setRemoteStream(null);

                // Show error toast if there's an error message
                if (data.error_message) {
                  toast.error("Stream Error", {
                    description: data.error_message,
                    duration: 5000,
                  });
                }

                // Close the peer connection to clean up
                if (peerConnectionRef.current) {
                  peerConnectionRef.current.close();
                  peerConnectionRef.current = null;
                }
                livepeerStreamIdRef.current = null;
                setLivepeerStreamId(null);
                // Notify parent component
                if (onStreamStop) {
                  onStreamStop();
                }
              }
            } catch (error) {
              console.error("Failed to parse data channel message:", error);
            }
          };

          dataChannel.onerror = error => {
            console.error("Data channel error:", error);
          };
        } else {
          dataChannelRef.current = null;

          try {
            const response = await startLivepeerStream({
              initialParameters,
            });

            whepUrl = response.whep_url;
            livepeerStreamIdRef.current = response.stream_id;
            setLivepeerStreamId(response.stream_id);

            console.log("Received Livepeer WHEP URL and stream ID:", whepUrl);
          } catch (error) {
            console.error("Failed to start Livepeer stream:", error);
            livepeerStreamIdRef.current = null;
            setLivepeerStreamId(null);
            throw error;
          }
        }

        // Add video track for sending to server only if stream is provided
        if (stream) {
          stream.getTracks().forEach(track => {
            if (track.kind === "video") {
              console.log("Adding video track for sending");
              pc.addTrack(track, stream);
            }
          });
        } else {
          console.log(
            "No video stream provided - adding video transceiver for no-input pipelines"
          );
          // For no-video-input pipelines, add a video transceiver to establish proper WebRTC connection
          pc.addTransceiver("video");
        }

        // Named event handlers
        const onTrack = (evt: RTCTrackEvent) => {
          if (evt.streams && evt.streams[0]) {
            console.log("Setting remote stream:", evt.streams[0]);
            setRemoteStream(evt.streams[0]);
          }
        };

        const onConnectionStateChange = () => {
          console.log("Connection state changed:", pc.connectionState);
          setConnectionState(pc.connectionState);

          if (pc.connectionState === "connected") {
            setIsConnecting(false);
            setIsStreaming(true);
          } else if (
            pc.connectionState === "disconnected" ||
            pc.connectionState === "failed" ||
            pc.connectionState === "closed"
          ) {
            setIsConnecting(false);
            setIsStreaming(false);
            if (isLivepeerTransport) {
              livepeerStreamIdRef.current = null;
              setLivepeerStreamId(null);
            }
          }
        };

        const onIceConnectionStateChange = () => {
          console.log("ICE connection state changed:", pc.iceConnectionState);
        };

        const onIceCandidate = async ({
          candidate,
        }: RTCPeerConnectionIceEvent) => {
          if (candidate) {
            console.log("ICE candidate:", candidate);
          } else {
            // ICE gathering complete - now send the offer
            console.log("ICE gathering complete, sending offer to server");
            try {
              if (isLivepeerTransport) {
                if (!whepUrl) {
                  throw new Error("Missing WHEP URL for Livepeer transport");
                }

                const localDescription = pc.localDescription;
                if (!localDescription?.sdp) {
                  throw new Error(
                    "Local description missing during WHEP negotiation"
                  );
                }

                const whepResponse = await fetch(whepUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/sdp" },
                  body: localDescription.sdp,
                });

                if (!whepResponse.ok) {
                  const errorText = await whepResponse.text();
                  throw new Error(
                    `WHEP negotiation failed: ${whepResponse.status} ${whepResponse.statusText}: ${errorText}`
                  );
                }

                const contentType = whepResponse.headers.get("content-type") || "";
                let answerSdp: string | undefined;

                if (contentType.includes("application/json")) {
                  const json = await whepResponse.json();
                  answerSdp = json.sdp || json.answer || json.data;
                } else {
                  answerSdp = await whepResponse.text();
                }

                if (!answerSdp) {
                  throw new Error("WHEP negotiation response missing SDP answer");
                }

                const answer: RTCSessionDescriptionInit = {
                  type: "answer",
                  sdp: answerSdp,
                };

                console.log("Received Livepeer WHEP answer");
                await pc.setRemoteDescription(answer);
              } else {
                const answer = await sendWebRTCOffer({
                  sdp: pc.localDescription!.sdp,
                  type: pc.localDescription!.type,
                  initialParameters,
                });

                console.log("Received server answer:", answer);
                await pc.setRemoteDescription(answer);
              }
            } catch (error) {
              console.error("Error in offer/answer exchange:", error);
              setIsConnecting(false);
            }
          }
        };

        // Attach event handlers
        pc.ontrack = onTrack;
        pc.onconnectionstatechange = onConnectionStateChange;
        pc.oniceconnectionstatechange = onIceConnectionStateChange;
        pc.onicecandidate = onIceCandidate;

        // Create offer and start ICE gathering
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
      } catch (error) {
        console.error("Failed to start stream:", error);
        if (peerConnectionRef.current) {
          peerConnectionRef.current.close();
          peerConnectionRef.current = null;
        }
        livepeerStreamIdRef.current = null;
        setLivepeerStreamId(null);
        setIsConnecting(false);
        setIsStreaming(false);
      }
    },
    [isConnecting, onStreamStop, parameterTransport]
  );

  const updateVideoTrack = useCallback(
    async (newStream: MediaStream) => {
      if (peerConnectionRef.current && isStreaming) {
        try {
          const videoTrack = newStream.getVideoTracks()[0];
          if (!videoTrack) {
            console.error("No video track found in new stream");
            return false;
          }

          const sender = peerConnectionRef.current
            .getSenders()
            .find((s: RTCRtpSender) => s.track?.kind === "video");

          if (sender) {
            console.log("Replacing video track");
            await sender.replaceTrack(videoTrack);
            currentStreamRef.current = newStream;
            console.log("Video track replaced successfully");
            return true;
          } else {
            console.error("No video sender found in peer connection");
            return false;
          }
        } catch (error) {
          console.error("Failed to replace video track:", error);
          return false;
        }
      }
      return false;
    },
    [isStreaming]
  );

  const sendParameterUpdate = useCallback(
    async (params: PipelineParameterUpdate) => {
      // Filter out undefined/null parameters
      const filteredParams: PipelineParameterUpdate = {};
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          (filteredParams as Record<string, unknown>)[key] = value;
        }
      }

      if (Object.keys(filteredParams).length === 0) {
        return;
      }

      if (parameterTransport === "livepeer") {
        if (!livepeerStreamIdRef.current) {
          console.warn("Livepeer stream ID unavailable for parameter update");
          return;
        }

        try {
          await updatePipelineParameters(filteredParams);
          console.log("Sent parameter update via Livepeer relay:", filteredParams);
        } catch (error) {
          console.error("Failed to send parameter update via Livepeer relay:", error);
        }
        return;
      }

      if (
        dataChannelRef.current &&
        dataChannelRef.current.readyState === "open"
      ) {
        try {
          const message = JSON.stringify(filteredParams);
          dataChannelRef.current.send(message);
          console.log("Sent parameter update via WebRTC:", filteredParams);
        } catch (error) {
          console.error("Failed to send parameter update via WebRTC:", error);
        }
      } else {
        console.warn("Data channel not available for parameter update");
      }
    },
    [parameterTransport]
  );

  const stopStream = useCallback(() => {
    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Clear data channel reference
    dataChannelRef.current = null;

    // Clear current stream reference (but don't stop it - that's handled by useLocalVideo)
    currentStreamRef.current = null;
    livepeerStreamIdRef.current = null;
  setLivepeerStreamId(null);

    setRemoteStream(null);
    setConnectionState("new");
    setIsStreaming(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  return {
    remoteStream,
    connectionState,
    isConnecting,
    isStreaming,
    peerConnectionRef,
    startStream,
    stopStream,
    updateVideoTrack,
    sendParameterUpdate,
  };
}
