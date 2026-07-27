package com.laoji.nativeplatform.minutes

// [PRODUCT] LaoJi adds manual meeting ordering. The item geometry and context
// menu remain source-mapped; drag activation and persistence are LaoJi-owned.

import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.hypot

internal class MinutesMeetingReorderController(
  private val list: RecyclerView,
  private val adapter: MinutesMeetingAdapter,
  private val viewMode: () -> MinutesHomeViewMode,
  private val showContextMenu: (View, MinutesMeeting) -> Unit,
  private val dismissContextMenu: () -> Unit,
  private val onOrderChanged: (List<String>) -> Unit,
) : RecyclerView.OnItemTouchListener {
  private val touchSlop = ViewConfiguration.get(list.context).scaledTouchSlop.toFloat()
  private var canReorder = false
  private var armedHolder: MinutesMeetingAdapter.Holder? = null
  private var armedMeeting: MinutesMeeting? = null
  private var downX = 0f
  private var downY = 0f
  private var dragStarted = false
  private var dragMoved = false
  private var contextMenuShownForGesture = false

  var isDragging: Boolean = false
    private set

  private val gestureDetector = GestureDetector(
    list.context,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(event: MotionEvent): Boolean {
        clearArmed()
        contextMenuShownForGesture = false
        downX = event.x
        downY = event.y
        return true
      }

      override fun onLongPress(event: MotionEvent) {
        val child = list.findChildViewUnder(event.x, event.y) ?: return
        val holder = list.getChildViewHolder(child) as? MinutesMeetingAdapter.Holder ?: return
        val position = holder.bindingAdapterPosition
        val meeting = adapter.itemAt(position) ?: return
        if (!meeting.actionEnabled) return
        armedHolder = holder
        armedMeeting = meeting
        downX = event.x
        downY = event.y
        list.parent?.requestDisallowInterceptTouchEvent(true)
        holder.itemView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        // [PRODUCT] A stationary long press exposes the Feishu-mapped item
        // menu as soon as the threshold is reached. If this same gesture then
        // moves, ACTION_MOVE dismisses the menu and preserves LaoJi drag-sort.
        MinutesSwipeMenuLayout.closeOpenMenu()
        contextMenuShownForGesture = true
        showContextMenu(holder.contextMenuAnchor(), meeting)
      }
    },
  )

  private val itemTouchHelper = ItemTouchHelper(object : ItemTouchHelper.Callback() {
    override fun isLongPressDragEnabled(): Boolean = false

    override fun isItemViewSwipeEnabled(): Boolean = false

    override fun getMovementFlags(
      recyclerView: RecyclerView,
      viewHolder: RecyclerView.ViewHolder,
    ): Int {
      val position = viewHolder.bindingAdapterPosition
      val meeting = adapter.itemAt(position)
      if (!canReorder || viewHolder !is MinutesMeetingAdapter.Holder || meeting?.actionEnabled != true) {
        return makeMovementFlags(0, 0)
      }
      val dragFlags = if (viewMode() == MinutesHomeViewMode.GRID) {
        ItemTouchHelper.UP or ItemTouchHelper.DOWN or ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT
      } else {
        ItemTouchHelper.UP or ItemTouchHelper.DOWN
      }
      return makeMovementFlags(dragFlags, 0)
    }

    override fun onMove(
      recyclerView: RecyclerView,
      viewHolder: RecyclerView.ViewHolder,
      target: RecyclerView.ViewHolder,
    ): Boolean {
      if (!canReorder || viewHolder !is MinutesMeetingAdapter.Holder || target !is MinutesMeetingAdapter.Holder) {
        return false
      }
      val from = viewHolder.bindingAdapterPosition
      val to = target.bindingAdapterPosition
      if (adapter.itemAt(to)?.actionEnabled != true || !adapter.moveItem(from, to)) return false
      dragMoved = true
      viewHolder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      return true
    }

    override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) = Unit

    override fun onSelectedChanged(viewHolder: RecyclerView.ViewHolder?, actionState: Int) {
      super.onSelectedChanged(viewHolder, actionState)
      if (actionState != ItemTouchHelper.ACTION_STATE_DRAG || viewHolder == null) return
      isDragging = true
      viewHolder.itemView.animate()
        .scaleX(1.025f)
        .scaleY(1.025f)
        .translationZ(list.context.dp(4).toFloat())
        .setDuration(120L)
        .start()
    }

    override fun clearView(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder) {
      super.clearView(recyclerView, viewHolder)
      viewHolder.itemView.animate()
        .scaleX(1f)
        .scaleY(1f)
        .translationZ(0f)
        .setDuration(120L)
        .start()
      val changed = dragMoved
      isDragging = false
      dragStarted = false
      dragMoved = false
      clearArmed()
      list.parent?.requestDisallowInterceptTouchEvent(false)
      if (changed) {
        val meetingIds = adapter.orderedTargetMeetingIds()
        if (meetingIds.size > 1 && meetingIds.none { it.isBlank() } && meetingIds.toSet().size == meetingIds.size) {
          onOrderChanged(meetingIds)
        }
      }
    }
  })

  init {
    // Register the arming detector first. Once startDrag() selects a holder,
    // ItemTouchHelper takes over the following movement events.
    list.addOnItemTouchListener(this)
    itemTouchHelper.attachToRecyclerView(list)
  }

  fun setCanReorder(value: Boolean) {
    canReorder = value
    if (!value && !isDragging) clearArmed()
  }

  override fun onInterceptTouchEvent(recyclerView: RecyclerView, event: MotionEvent): Boolean {
    gestureDetector.onTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        val holder = armedHolder ?: return false
        val movedPastSlop = hypot(event.x - downX, event.y - downY) > touchSlop
        if (!movedPastSlop) return false
        val meeting = armedMeeting
        if (!canReorder || meeting?.actionEnabled != true || holder.bindingAdapterPosition == RecyclerView.NO_POSITION) {
          clearArmed()
          recyclerView.parent?.requestDisallowInterceptTouchEvent(false)
          return false
        }
        if (!dragStarted) {
          dragStarted = true
          MinutesSwipeMenuLayout.closeOpenMenu()
          if (contextMenuShownForGesture) {
            dismissContextMenu()
            contextMenuShownForGesture = false
          }
          itemTouchHelper.startDrag(holder)
        }
      }
      MotionEvent.ACTION_UP -> {
        val consumeLongPress = !dragStarted && contextMenuShownForGesture
        if (!dragStarted) clearArmed()
        contextMenuShownForGesture = false
        recyclerView.parent?.requestDisallowInterceptTouchEvent(false)
        if (consumeLongPress) return true
      }
      MotionEvent.ACTION_CANCEL -> {
        if (!dragStarted) clearArmed()
        contextMenuShownForGesture = false
        recyclerView.parent?.requestDisallowInterceptTouchEvent(false)
      }
    }
    return false
  }

  override fun onTouchEvent(recyclerView: RecyclerView, event: MotionEvent) {
    if (event.actionMasked == MotionEvent.ACTION_CANCEL || event.actionMasked == MotionEvent.ACTION_UP) {
      if (!dragStarted) clearArmed()
      contextMenuShownForGesture = false
      recyclerView.parent?.requestDisallowInterceptTouchEvent(false)
    }
  }

  override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) = Unit

  private fun clearArmed() {
    armedHolder = null
    armedMeeting = null
  }
}
