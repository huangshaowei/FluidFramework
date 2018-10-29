import { IDocumentMessage, MessageType } from "@prague/runtime-definitions";
import * as socketStorage from "@prague/socket-storage";
import { Deferred } from "@prague/utils";
import * as assert from "assert";
import * as io from "../../alfred/io";
import * as core from "../../core";
import * as services from "../../services";
import * as utils from "../../utils";
import {
    MessageFactory,
    TestDbFactory,
    TestKafka,
    TestTenantManager,
    TestWebSocket,
    TestWebSocketServer,
} from "../testUtils";

describe("Routerlicious", () => {
    describe("Alfred", () => {
        describe("WebSockets", () => {
            describe("Messages", () => {
                const testTenantId = "test";
                const testSecret = "test";
                const testId = "test";

                let webSocketServer: TestWebSocketServer;
                let deliKafka: TestKafka;
                let testOrderer: core.IOrdererManager;
                let testTenantManager: TestTenantManager;

                beforeEach(() => {
                    const collectionNames = "test";
                    const metricClientConfig = {};
                    const testData: { [key: string]: any[] } = {};

                    deliKafka = new TestKafka();
                    const producer = deliKafka.createProducer();
                    testTenantManager = new TestTenantManager();
                    const testDbFactory = new TestDbFactory(testData);
                    const mongoManager = new utils.MongoManager(testDbFactory);
                    const databaseManager = new utils.MongoDatabaseManager(
                        mongoManager,
                        collectionNames,
                        collectionNames,
                        collectionNames);
                    const testStorage = new services.DocumentStorage(
                        databaseManager,
                        testTenantManager,
                        producer);
                    const kafkaOrderer = new services.KafkaOrdererFactory(producer, testStorage, 1024 * 1024);
                    testOrderer = new services.OrdererManager(null, kafkaOrderer);

                    webSocketServer = new TestWebSocketServer();

                    io.register(
                        webSocketServer,
                        metricClientConfig,
                        testOrderer,
                        testTenantManager);
                });

                function connectToServer(
                    id: string,
                    tenantId: string,
                    secret: string,
                    socket: TestWebSocket): Promise<socketStorage.IConnected> {
                    const token = utils.generateToken(tenantId, id, secret);

                    const connectMessage: socketStorage.IConnect = {
                        client: undefined,
                        id,
                        tenantId,
                        token,
                    };

                    const deferred = new Deferred<socketStorage.IConnected>();

                    socket.on("connect_document_success", (connectedMessage: socketStorage.IConnected) => {
                        deferred.resolve(connectedMessage);
                    });

                    socket.on("connect_document_error", (error: any) => {
                        deferred.reject(error);
                    });

                    socket.send(
                        "connect_document",
                        connectMessage,
                        (error: any, connectedMessage: socketStorage.IConnected) => {
                            if (error) {
                                deferred.reject(error);
                            } else {
                                deferred.resolve(connectedMessage);
                            }
                        });

                    return deferred.promise;
                }

                function sendMessage(
                    socket: TestWebSocket,
                    clientId: string,
                    message: IDocumentMessage): Promise<void> {

                    const deferred = new Deferred<void>();
                    socket.send("submitOp", clientId, [message], (error: any, response: any) => {
                        if (error) {
                            deferred.reject(error);
                        } else {
                            deferred.resolve(response);
                        }
                    });

                    return deferred.promise;
                }

                describe("#connect_document", () => {
                    it("Should connect to and create a new interactive document on first connection", async () => {
                        const socket = webSocketServer.createConnection();
                        const connectMessage = await connectToServer(testId, testTenantId, testSecret, socket);
                        assert.ok(connectMessage.clientId);
                        assert.equal(connectMessage.existing, false);

                        // Verify a connection message was sent
                        const message = deliKafka.getLastMessage();
                        assert.equal(message.documentId, testId);
                        assert.equal(message.operation.clientId, null);
                        assert.equal(message.operation.type, MessageType.ClientJoin);
                        assert.equal(message.operation.contents.clientId, connectMessage.clientId);
                    });

                    it("Should connect to and set existing flag to true when connecting to an existing document",
                        async () => {
                            const firstSocket = webSocketServer.createConnection();
                            const firstConnectMessage = await connectToServer(
                                testId, testTenantId, testSecret, firstSocket);
                            assert.equal(firstConnectMessage.existing, false);

                            const secondSocket = webSocketServer.createConnection();
                            const secondConnectMessage = await connectToServer(
                                testId, testTenantId, testSecret, secondSocket);
                            assert.equal(secondConnectMessage.existing, true);
                        });
                });

                describe("#disconnect", () => {
                    it("Should disconnect from an interactive document", async () => {
                        const socket = webSocketServer.createConnection();
                        const connectMessage = await connectToServer(testId, testTenantId, testSecret, socket);
                        socket.send("disconnect");

                        // Connect a second client just to have something to await on.
                        // There is no ack for the disconnect, but the message will be ordered with future messages.
                        await connectToServer(testId, testTenantId, testSecret, webSocketServer.createConnection());

                        assert.equal(deliKafka.getRawMessages().length, 3);
                        const message = deliKafka.getMessage(1);
                        assert.equal(message.documentId, testId);
                        assert.equal(message.operation.clientId, null);
                        assert.equal(message.operation.type, MessageType.ClientLeave);
                        assert.equal(message.operation.contents, connectMessage.clientId);
                    });
                });

                describe("#submitOp", () => {
                    it("Can connect to the web socket server", async () => {
                        const socket = webSocketServer.createConnection();
                        const connectMessage = await connectToServer(testId, testTenantId, testSecret, socket);

                        const messageFactory = new MessageFactory(testId, connectMessage.clientId);
                        const message = messageFactory.createDocumentMessage();

                        const beforeCount = deliKafka.getRawMessages().length;
                        await sendMessage(socket, connectMessage.clientId, message);
                        assert.equal(deliKafka.getRawMessages().length, beforeCount + 1);
                        const lastMessage = deliKafka.getLastMessage();
                        assert.equal(lastMessage.documentId, testId);
                        assert.equal(lastMessage.type, core.RawOperationType);
                        assert.deepEqual(lastMessage.operation, message);
                    });
                });
            });
        });
    });
});
