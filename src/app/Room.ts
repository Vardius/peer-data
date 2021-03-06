import { v4 as uuidv4 } from 'uuid';
import { EventDispatcher } from './EventDispatcher';
import { Configuration } from './Configuration';
import { Identifiable, SignalingEvent, SignalingEventType } from './Signaling';
import { EventHandler } from './EventHandler';
import { Participant } from './Participant';

export class Room {
    private id: string;
    private participantId: string;
    private configuration: Configuration;
    private appDispatcher: EventDispatcher;
    private participants: Map<string, Participant> = new Map();
    private dispatcher: EventDispatcher = new EventDispatcher();
    private stream?: MediaStream;

    constructor(id: string, configuration: Configuration, appDispatcher: EventDispatcher, stream?: MediaStream) {
        this.id = id;
        this.stream = stream;
        this.participantId = uuidv4();
        this.configuration = configuration;
        this.appDispatcher = appDispatcher;

        this.appDispatcher.dispatch('send', {
            type: SignalingEventType.CONNECT,
            caller: { id: this.participantId },
            callee: null,
            room: { id: this.id },
            payload: null,
        } as SignalingEvent);
    }

    getId = (): string => this.id;

    getParticipantId = (): string => this.participantId;

    getEventDispatcher = (): EventDispatcher => this.appDispatcher;

    getConfiguration = (): Configuration => this.configuration;

    getStream = (): MediaStream | undefined => this.stream;

    on = (event: string, callback: EventHandler): Room => {
        this.dispatcher.register(event, callback);

        return this;
    };

    send = (payload: any): Room => {
        this.participants.forEach((participant: Participant): Participant => participant.send(payload));

        return this;
    };

    disconnect = (): Room => {
        this.appDispatcher.dispatch('send', {
            type: SignalingEventType.DISCONNECT,
            caller: { id: this.participantId },
            callee: null,
            room: { id: this.id },
            payload: null,
        } as SignalingEvent);

        const keys = Array.from(this.participants.keys());
        for (const key of keys) {
            const participant = (this.participants.get(key) as Participant);

            this.participants.delete(key);

            participant.close();
        }

        return this;
    };

    onSignalingEvent = (event: SignalingEvent): Room => {
        if (this.id !== event.room.id) {
            return this;
        }

        switch (event.type) {
        case SignalingEventType.CONNECT:
            this.onConnect(event);
            break;
        case SignalingEventType.OFFER:
            this.onOffer(event);
            break;
        case SignalingEventType.DISCONNECT:
            this.onDisconnect(event);
            break;
        case SignalingEventType.ANSWER:
        case SignalingEventType.CANDIDATE:
            const caller = (event.caller as Identifiable);
            if (this.participants.has(caller.id)) {
                const participant = (this.participants.get(caller.id) as Participant);

                participant.onSignalingEvent(event);
            }
            break;
        }

        return this;
    };

    private onOffer = async (event: SignalingEvent): Promise<void> => {
        const desc = new RTCSessionDescription(event.payload);
        const caller = (event.caller as Identifiable);

        if (this.participants.has(caller.id)) {
            const participant = (this.participants.get(caller.id) as Participant);

            try {
                await participant.renegotiate(desc);
            } catch (err) {
                this.dispatcher.dispatch('error', err);
            }
        } else {
            const participant = new Participant(caller.id, this);

            this.participants.set(participant.getId(), participant);
            this.dispatcher.dispatch('participant', participant);

            try {
                await participant.renegotiate(desc);
            } catch (err) {
                this.dispatcher.dispatch('error', err);
            }
        }
    };

    private onConnect = (event: SignalingEvent): void => {
        const caller = (event.caller as Identifiable);

        if (!this.participants.has(caller.id)) {
            const participant = new Participant(caller.id, this);

            this.participants.set(participant.getId(), participant);
            this.dispatcher.dispatch('participant', participant);
        }
    };

    private onDisconnect = (event: SignalingEvent): void => {
        const caller = (event.caller as Identifiable);

        if (this.participants.has(caller.id)) {
            const participant = (this.participants.get(caller.id) as Participant);

            this.participants.delete(caller.id);

            participant.close();
        }
    };
}
