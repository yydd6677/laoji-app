package com.laoji.nativeplatform.audio

import java.util.concurrent.CompletableFuture
import okhttp3.Request
import okhttp3.Response
import okhttp3.Protocol
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test

class RealtimeSocketCallbackOwnerTest {
  private class Socket : WebSocket {
    var cancels = 0
    override fun request() = Request.Builder().url("http://127.0.0.1/").build()
    override fun queueSize() = 0L
    override fun send(text: String) = true
    override fun send(bytes: ByteString) = true
    override fun close(code: Int, reason: String?) = true
    override fun cancel() { cancels++ }
  }
  private fun fixture(): Triple<RealtimeAsrSocket, WebSocketListener, CompletableFuture<Unit>> {
    val subject = RealtimeAsrSocket(RecorderStartConfig.createLocalMeeting("callback-test", null, 100.0),
      object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) = Unit
        override fun onServerError(error: AsrServerEvent.Error) = Unit
        override fun onTransportFailure(code: RecorderErrorCode, message: String) = Unit
      })
    val callback = RealtimeAsrSocket::class.java.declaredClasses.single { it.simpleName == "SocketListener" }
      .declaredConstructors.single().also { it.isAccessible = true }.newInstance(subject) as WebSocketListener
    @Suppress("UNCHECKED_CAST")
    val future = RealtimeAsrSocket::class.java.getDeclaredField("connection").also { it.isAccessible = true }
      .get(subject) as CompletableFuture<Unit>
    return Triple(subject, callback, future)
  }
  @Test fun cancelledPendingConnectCannotReopenFromLateCallback() {
    val (subject, callback, future) = fixture()
    subject.cancel()
    val socket = Socket()
    callback.onOpen(socket, Response.Builder().request(socket.request()).protocol(Protocol.HTTP_1_1)
      .code(101).message("Switching Protocols").build())
    assertFalse(subject.isOpen())
    assertTrue(future.isCompletedExceptionally)
    assertEquals(1, socket.cancels)
  }
  @Test fun serverCloseBeforeOpenSettlesConnectWithoutWaitingForAnotherDeadline() {
    val (subject, callback, future) = fixture()
    callback.onClosing(Socket(), 1008, "private authentication detail")
    assertFalse(subject.isOpen())
    assertTrue(future.isCompletedExceptionally)
  }
}
