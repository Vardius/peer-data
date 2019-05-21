import { EventDispatcher } from './EventDispatcher';
import { SignalingEvent, SignalingEventType } from './Signaling';
import { EventHandler } from './EventHandler';
import { Configuration } from './Configuration';
import { Room } from './Room';

export class Participant {
  private id: string;
  private room: Room;
  private peer: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private dispatcher: EventDispatcher = new EventDispatcher();
  private offerAnswerOptions: RTCOfferOptions;

  constructor(id: string, room: Room) {
    this.id = id;
    this.room = room;
    this.offerAnswerOptions = {
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    };

    this.peer = new RTCPeerConnection(Configuration.getInstance().getServers());
    this.peer.onicecandidate = this.onIceCandidate;
    this.peer.onconnectionstatechange = this.onConnectionStateChange;
    this.peer.oniceconnectionstatechange = this.onIceConnectionStateChange;
    this.peer.ondatachannel = this.onDataChannel;
    this.peer.ontrack = this.dispatchRemoteStream;

    const stream = this.room.getStream();
    if (stream instanceof MediaStream) {
      stream.getTracks().map(track => this.peer.addTrack(track, stream));
    }
  }

  getId = (): string => this.id;

  on = (event: string, callback: EventHandler): Participant => {
    this.dispatcher.register(event, callback);

    return this;
  }

  send = (payload: any): Participant => {
    if (!this.channel || this.channel.readyState !== 'open') {
      return this;
    }

    this.channel.send(payload);

    return this;
  }

  close = (): Participant => {
    if (this.channel) {
      this.channel.close();
    }

    this.peer.close();
    this.dispatcher.dispatch('disconnected');

    return this;
  }

  onSignalingEvent = (event: SignalingEvent): Participant => {
    if (!event.caller || this.id !== event.caller.id) {
      return this;
    }

    switch (event.type) {
      case SignalingEventType.ANSWER:
        this.onAnswer(event);
        break;
      case SignalingEventType.CANDIDATE:
        this.onCandidate(event);
        break;
    }

    return this;
  }

  init = async (remoteDesc?: RTCSessionDescription): Promise<Participant> => {
    if (remoteDesc) {
      return await this.peer
        .setRemoteDescription(remoteDesc)
        .then(() => this.peer.createAnswer(this.offerAnswerOptions))
        .then((desc: RTCSessionDescriptionInit) => this.peer.setLocalDescription(desc))
        .then(() => EventDispatcher.getInstance().dispatch('send', {
          type: SignalingEventType.ANSWER,
          caller: null,
          callee: { id: this.id },
          room: { id: this.room.getId() },
          payload: this.peer.localDescription,
        } as SignalingEvent))
        .then(() => this);
    } else {
      this.channel = this.newDataChannel(Configuration.getInstance().getDataConstraints());
      this.channel.onmessage = this.onMessage;

      return await this.peer
        .createOffer(this.offerAnswerOptions)
        .then((desc: RTCSessionDescriptionInit) => this.peer.setLocalDescription(desc))
        .then(() => EventDispatcher.getInstance().dispatch('send', {
          type: SignalingEventType.OFFER,
          caller: null,
          callee: { id: this.id },
          room: { id: this.room.getId() },
          payload: this.peer.localDescription,
        } as SignalingEvent))
        .then(() => this);
    }
  }

  renegotiate = (remoteDesc?: RTCSessionDescription) => {
    if (remoteDesc) {
      this.peer
        .setRemoteDescription(remoteDesc)
        .then(() => this.peer.createAnswer(this.offerAnswerOptions))
        .then((desc: RTCSessionDescriptionInit) => this.peer.setLocalDescription(desc))
        .then(() => EventDispatcher.getInstance().dispatch('send', {
          type: SignalingEventType.ANSWER,
          caller: null,
          callee: { id: this.id },
          room: { id: this.room.getId() },
          payload: this.peer.localDescription,
        } as SignalingEvent))
        .catch((evnt: DOMException) => this.dispatcher.dispatch('error', evnt));
    } else {
      this.channel = this.newDataChannel(Configuration.getInstance().getDataConstraints());
      this.channel.onmessage = this.onMessage;

      this.peer
        .createOffer(this.offerAnswerOptions)
        .then((desc: RTCSessionDescriptionInit) => this.peer.setLocalDescription(desc))
        .then(() => EventDispatcher.getInstance().dispatch('send', {
          type: SignalingEventType.OFFER,
          caller: null,
          callee: { id: this.id },
          room: { id: this.room.getId() },
          payload: this.peer.localDescription,
        } as SignalingEvent))
        .catch((evnt: DOMException) => this.dispatcher.dispatch('error', evnt));
    }
  }

  private newDataChannel = (dataConstraints?: RTCDataChannelInit): RTCDataChannel => {
    const label = Math.floor((1 + Math.random()) * 1e16)
      .toString(16)
      .substring(1);

    return this.peer.createDataChannel(label, dataConstraints);
  }

  private onAnswer = (event: SignalingEvent) => {
    this.peer
      .setRemoteDescription(new RTCSessionDescription(event.payload))
      .catch((evnt: DOMException) => this.dispatcher.dispatch('error', evnt));
  }

  private onCandidate = (event: SignalingEvent) => {
    this.peer
      .addIceCandidate(new RTCIceCandidate(event.payload))
      .catch((evnt: DOMException) => this.dispatcher.dispatch('error', evnt));
  }

  private onIceCandidate = (iceEvent: RTCPeerConnectionIceEvent) => {
    if (iceEvent.candidate) {
      EventDispatcher.getInstance().dispatch('send', {
        type: SignalingEventType.CANDIDATE,
        caller: null,
        callee: { id: this.id },
        room: { id: this.room.getId() },
        payload: iceEvent.candidate as RTCIceCandidate,
      } as SignalingEvent);
    } else {
      // All ICE candidates have been sent
    }
  }

  private onConnectionStateChange = () => {
    switch (this.peer.connectionState) {
      case 'connected':
        // The connection has become fully connected
        break;
      case 'disconnected':
      case 'failed':
      // One or more transports has terminated unexpectedly or in an error
      case 'closed':
        this.dispatcher.dispatch('disconnected');
        // The connection has been closed
        break;
    }
  }

  private onIceConnectionStateChange = () => {
    switch (this.peer.iceConnectionState) {
      case 'disconnected':
      case 'failed':
      case 'closed':
        this.dispatcher.dispatch('disconnected');
        break;
    }
  }

  private onDataChannel = (event: RTCDataChannelEvent) => {
    this.channel = event.channel;
    this.channel.onmessage = this.onMessage;
  }

  private onMessage = (event: MessageEvent) => {
    this.dispatcher.dispatch('message', event.data);
  }

  private dispatchRemoteStream = (event: RTCTrackEvent) => {
    this.dispatcher.dispatch('track', event);
  }
}
