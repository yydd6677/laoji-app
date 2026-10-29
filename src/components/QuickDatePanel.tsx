import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors as C } from '../theme/colors';
import { useCurrentDate } from '../hooks/useCurrentDate';
import type { CalEvent } from '../types';
import { selectTasksForDate } from '../utils/taskOrdering';
import {
  addMonths,
  formatMonthTitle,
  isSameDay,
  monthCells,
  monthWeekCount,
  startOfMonth,
} from '../utils/calendarDate';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const HEADER_HEIGHT = 46;
const WEEKDAY_HEIGHT = 32;
const CELL_HEIGHT = 38;
const DRAG_BAR_HEIGHT = 28;
const DRAG_BAR_MARGIN_TOP = 2;
const DRAG_BAR_TOTAL_HEIGHT = DRAG_BAR_HEIGHT + DRAG_BAR_MARGIN_TOP;
const SHADOW_BUFFER_HEIGHT = 15;
const OPEN_ANIMATION_MS = 200;
const PICKER_TRANSITION_MS = 150;
const DATE_HEIGHT_ANIMATION_MS = 100;
const DRAG_SLOP = 6;
const WHEEL_ITEM_HEIGHT = 48;
const WHEEL_VISIBLE_ITEMS = 5;
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ITEMS;
const WHEEL_LOOP_COPIES = 5;
const WHEEL_LOOP_CENTER_COPY = Math.floor(WHEEL_LOOP_COPIES / 2);
const YEAR_MONTH_CONTENT_HEIGHT = WHEEL_HEIGHT + 16;
const YEAR_START = 1900;
const YEAR_END = 2100;

const accelerateDecelerate = (progress: number) => (
  Math.cos((progress + 1) * Math.PI) / 2 + 0.5
);

type PickerMode = 'date' | 'yearMonth';
export type QuickDatePanelMode = 'dateYearMonth' | 'yearMonthOnly';

function WheelColumn({
  values,
  selectedIndex,
  accessibilityLabel,
  testID,
  loop = false,
  onSelect,
}: {
  values: string[];
  selectedIndex: number;
  accessibilityLabel: string;
  testID: string;
  loop?: boolean;
  onSelect: (index: number) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const gestureActive = useRef(false);
  const renderedValues = useMemo(() => {
    const copies = loop ? WHEEL_LOOP_COPIES : 1;
    return Array.from({ length: values.length * copies }, (_, index) => ({
      value: values[index % values.length],
      valueIndex: index % values.length,
      primary: !loop || Math.floor(index / values.length) === WHEEL_LOOP_CENTER_COPY,
    }));
  }, [loop, values]);
  const physicalIndexFor = useCallback((index: number) => {
    const canonicalIndex = Math.max(0, Math.min(values.length - 1, index));
    return loop
      ? WHEEL_LOOP_CENTER_COPY * values.length + canonicalIndex
      : canonicalIndex;
  }, [loop, values.length]);
  const [activeIndex, setActiveIndex] = useState(() => physicalIndexFor(selectedIndex));

  useEffect(() => {
    const next = physicalIndexFor(selectedIndex);
    setActiveIndex(next);
    scrollRef.current?.scrollTo({ y: next * WHEEL_ITEM_HEIGHT, animated: false });
  }, [physicalIndexFor, selectedIndex]);

  const settle = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
    deferWhileMoving = false,
  ) => {
    if (!gestureActive.current) return;
    if (deferWhileMoving && Math.abs(event.nativeEvent.velocity?.y ?? 0) > 0.05) return;
    gestureActive.current = false;
    const next = Math.max(0, Math.min(
      renderedValues.length - 1,
      Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT),
    ));
    const valueIndex = renderedValues[next]?.valueIndex ?? 0;
    const settledIndex = physicalIndexFor(valueIndex);
    setActiveIndex(settledIndex);
    const settledOffset = settledIndex * WHEEL_ITEM_HEIGHT;
    if (Math.abs(event.nativeEvent.contentOffset.y - settledOffset) > 0.5) {
      scrollRef.current?.scrollTo({ y: settledOffset, animated: deferWhileMoving });
    }
    onSelect(valueIndex);
  };

  const choose = (index: number) => {
    setActiveIndex(index);
    scrollRef.current?.scrollTo({ y: index * WHEEL_ITEM_HEIGHT, animated: true });
    onSelect(renderedValues[index]?.valueIndex ?? 0);
  };

  const adjust = (amount: number) => {
    const current = renderedValues[activeIndex]?.valueIndex ?? selectedIndex;
    const next = loop
      ? (current + amount + values.length) % values.length
      : Math.max(0, Math.min(values.length - 1, current + amount));
    choose(physicalIndexFor(next));
  };

  const activeValueIndex = renderedValues[activeIndex]?.valueIndex ?? selectedIndex;

  return (
    <View
      style={s.wheelColumn}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: values[activeValueIndex] }}
      accessibilityActions={[
        { name: 'decrement', label: '上一个' },
        { name: 'increment', label: '下一个' },
      ]}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'decrement') adjust(-1);
        if (event.nativeEvent.actionName === 'increment') adjust(1);
      }}
      testID={testID}
    >
      <ScrollView
        ref={scrollRef}
        testID={`${testID}-scroll`}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM_HEIGHT}
        decelerationRate="fast"
        nestedScrollEnabled
        contentOffset={{ x: 0, y: physicalIndexFor(selectedIndex) * WHEEL_ITEM_HEIGHT }}
        contentContainerStyle={s.wheelContent}
        onScrollBeginDrag={() => {
          gestureActive.current = true;
        }}
        onScrollEndDrag={event => settle(event, true)}
        onMomentumScrollEnd={event => settle(event)}
      >
        {renderedValues.map((item, index) => {
          const distance = Math.min(2, Math.abs(index - activeIndex));
          return (
            <TouchableOpacity
              key={`${item.value}-${index}`}
              style={s.wheelItem}
              onPress={() => choose(index)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ selected: index === activeIndex }}
              accessibilityLabel={item.primary ? item.value : undefined}
              accessibilityElementsHidden={!item.primary}
              importantForAccessibility={item.primary ? 'auto' : 'no-hide-descendants'}
            >
              <Text style={[
                s.wheelText,
                index === activeIndex && s.wheelTextSelected,
                distance === 1 && s.wheelTextNear,
                distance >= 2 && s.wheelTextFar,
              ]}>
                {item.value}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View pointerEvents="none" style={[s.wheelDivider, s.wheelDividerTop]} />
      <View pointerEvents="none" style={[s.wheelDivider, s.wheelDividerBottom]} />
    </View>
  );
}

function YearMonthPicker({ month, onMonthChange }: {
  month: Date;
  onMonthChange: (month: Date) => void;
}) {
  const years = useMemo(
    () => Array.from({ length: YEAR_END - YEAR_START + 1 }, (_, index) => `${YEAR_START + index}年`),
    [],
  );
  const monthValues = useMemo(
    () => Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
    [],
  );
  const yearIndex = month.getFullYear() - YEAR_START;
  const monthIndex = month.getMonth();

  const changeYear = (index: number) => {
    const year = YEAR_START + index;
    const next = new Date(year, month.getMonth(), 1);
    onMonthChange(startOfMonth(next));
  };

  const changeMonth = (index: number) => {
    const next = new Date(month.getFullYear(), index % 12, 1);
    onMonthChange(startOfMonth(next));
  };

  return (
    <View style={s.yearMonthPicker} testID="quick-date-year-month-picker">
      <WheelColumn
        values={years}
        selectedIndex={Math.max(0, Math.min(years.length - 1, yearIndex))}
        accessibilityLabel="选择年份"
        testID="quick-date-year-wheel"
        onSelect={changeYear}
      />
      <WheelColumn
        values={monthValues}
        selectedIndex={monthIndex}
        accessibilityLabel="选择月份"
        testID="quick-date-month-wheel"
        loop
        onSelect={changeMonth}
      />
    </View>
  );
}

function QuickDateMonthPage({
  month,
  width,
  active,
  selectedDate,
  today,
  events,
  onSelectDate,
}: {
  month: Date;
  width: number;
  active: boolean;
  selectedDate: Date;
  today: Date;
  events: CalEvent[];
  onSelectDate: (date: Date) => void;
}) {
  const cells = useMemo(() => monthCells(month), [month]);

  return (
    <View
      style={[s.monthPage, { width, height: monthWeekCount(month) * CELL_HEIGHT }]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {cells.map(cell => {
        const selected = isSameDay(cell.date, selectedDate);
        const current = isSameDay(cell.date, today);
        const hasEvents = selectTasksForDate(events, cell.key).length > 0;
        return (
          <TouchableOpacity
            key={cell.key}
            style={s.cell}
            onPress={() => active && onSelectDate(cell.date)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${cell.date.getMonth() + 1}月${cell.date.getDate()}日${current ? '，今天' : ''}`}
          >
            <View style={[
              s.dateCircle,
              selected && current && s.dateCircleToday,
              selected && !current && s.dateCircleSelected,
            ]}>
              <Text style={[
                s.dateText,
                !cell.inMonth && s.dateTextAdjacent,
                current && !selected && s.dateTextToday,
                selected && current && s.dateTextSelectedToday,
                selected && !current && s.dateTextSelected,
              ]}>
                {cell.date.getDate()}
              </Text>
            </View>
            <View style={s.dotSlot}>
              {hasEvents ? <View style={[s.dot, !cell.inMonth && s.dotAdjacent]} /> : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function QuickDateMonthPager({
  month,
  selectedDate,
  today,
  events,
  onSelectDate,
  onMonthChange,
}: {
  month: Date;
  selectedDate: Date;
  today: Date;
  events: CalEvent[];
  onSelectDate: (date: Date) => void;
  onMonthChange: (month: Date) => void;
}) {
  const { width } = useWindowDimensions();
  const pageWidth = Math.max(1, width);
  const pagerRef = useRef<ScrollView | null>(null);
  const monthGestureActive = useRef(false);
  const monthGestureHandled = useRef(false);
  const pages = useMemo(() => [-1, 0, 1].map(offset => addMonths(month, offset)), [month]);
  const viewportHeight = monthWeekCount(month) * CELL_HEIGHT;

  useLayoutEffect(() => {
    pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
  }, [month, pageWidth]);

  const settleMonth = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!monthGestureActive.current || monthGestureHandled.current) return;
    const page = Math.max(0, Math.min(2, Math.round(event.nativeEvent.contentOffset.x / pageWidth)));
    monthGestureActive.current = false;
    monthGestureHandled.current = true;
    if (page === 1) {
      pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
      return;
    }
    onMonthChange(addMonths(month, page <= 0 ? -1 : 1));
  };

  const accessibilityShift = (event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === 'decrement') onMonthChange(addMonths(month, -1));
    if (event.nativeEvent.actionName === 'increment') onMonthChange(addMonths(month, 1));
  };

  return (
    <View style={[s.monthPagerViewport, { height: viewportHeight }]}>
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        bounces={false}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: pageWidth, y: 0 }}
        onScrollBeginDrag={() => {
          monthGestureActive.current = true;
          monthGestureHandled.current = false;
        }}
        onMomentumScrollEnd={settleMonth}
        scrollEventThrottle={16}
        accessibilityRole="adjustable"
        accessibilityLabel={`${month.getFullYear()}年${month.getMonth() + 1}月`}
        accessibilityHint="左右滑动切换月份"
        accessibilityActions={[
          { name: 'decrement', label: '上一个月' },
          { name: 'increment', label: '下一个月' },
        ]}
        onAccessibilityAction={accessibilityShift}
        testID="quick-date-month-pager"
      >
        {pages.map((pageMonth, index) => (
          <QuickDateMonthPage
            key={`${pageMonth.getFullYear()}-${pageMonth.getMonth()}`}
            month={pageMonth}
            width={pageWidth}
            active={index === 1}
            selectedDate={selectedDate}
            today={today}
            events={events}
            onSelectDate={onSelectDate}
          />
        ))}
      </ScrollView>
    </View>
  );
}

export function QuickDatePanel({
  visible,
  expandProgress,
  mode = 'dateYearMonth',
  top,
  month,
  selectedDate,
  events,
  onSelectDate,
  onMonthChange,
  onClose,
}: {
  visible: boolean;
  expandProgress?: Animated.Value;
  mode?: QuickDatePanelMode;
  top: number;
  month: Date;
  selectedDate: Date;
  events: CalEvent[];
  onSelectDate: (date: Date) => void;
  onMonthChange: (month: Date) => void;
  onClose: () => void;
}) {
  const yearMonthOnly = mode === 'yearMonthOnly';
  const initialPickerMode: PickerMode = yearMonthOnly ? 'yearMonth' : 'date';
  const weekCount = monthWeekCount(month);
  const dateContentHeight = WEEKDAY_HEIGHT + weekCount * CELL_HEIGHT;
  const datePanelHeight = HEADER_HEIGHT + dateContentHeight + DRAG_BAR_TOTAL_HEIGHT + SHADOW_BUFFER_HEIGHT;
  const yearMonthPanelHeight = HEADER_HEIGHT + YEAR_MONTH_CONTENT_HEIGHT + DRAG_BAR_TOTAL_HEIGHT + SHADOW_BUFFER_HEIGHT;
  const yearMonthOnlyPanelHeight = 8 + YEAR_MONTH_CONTENT_HEIGHT + DRAG_BAR_TOTAL_HEIGHT + SHADOW_BUFFER_HEIGHT;
  const entryPanelHeight = yearMonthOnly ? yearMonthOnlyPanelHeight : datePanelHeight;
  const [mounted, setMounted] = useState(visible);
  const [pickerMode, setPickerMode] = useState<PickerMode>(initialPickerMode);
  const mountedRef = useRef(visible);
  const pickerModeRef = useRef<PickerMode>(initialPickerMode);
  const initialPickerModeRef = useRef<PickerMode>(initialPickerMode);
  const entryPanelHeightRef = useRef(entryPanelHeight);
  const internalProgress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const progress = expandProgress ?? internalProgress;
  const progressValue = useRef(visible ? 1 : 0);
  const pickerTransition = useRef(new Animated.Value(initialPickerMode === 'yearMonth' ? 1 : 0)).current;
  const gestureStart = useRef(1);
  const previousDy = useRef(0);
  const dragDirection = useRef<-1 | 0 | 1>(0);
  const layoutHeight = useRef(new Animated.Value(entryPanelHeight)).current;
  const today = useCurrentDate();

  initialPickerModeRef.current = initialPickerMode;
  entryPanelHeightRef.current = entryPanelHeight;

  useEffect(() => {
    pickerModeRef.current = pickerMode;
  }, [pickerMode]);

  useEffect(() => {
    if (mountedRef.current) return;
    pickerModeRef.current = initialPickerMode;
    setPickerMode(initialPickerMode);
    pickerTransition.setValue(initialPickerMode === 'yearMonth' ? 1 : 0);
    layoutHeight.setValue(entryPanelHeight);
  }, [entryPanelHeight, initialPickerMode, layoutHeight, pickerTransition]);

  useEffect(() => {
    if (pickerMode !== 'date') return;
    Animated.timing(layoutHeight, {
      toValue: datePanelHeight,
      duration: DATE_HEIGHT_ANIMATION_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [datePanelHeight, layoutHeight, pickerMode]);

  const setProgress = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value));
    progressValue.current = next;
    progress.setValue(next);
  }, [progress]);

  const animateTo = useCallback((target: 0 | 1, callback?: () => void) => {
    progress.stopAnimation(currentValue => {
      const current = typeof currentValue === 'number' ? currentValue : progressValue.current;
      progressValue.current = current;
      Animated.timing(progress, {
        toValue: target,
        duration: Math.max(1, Math.round(OPEN_ANIMATION_MS * Math.abs(target - current))),
        easing: accelerateDecelerate,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        progressValue.current = target;
        callback?.();
      });
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      if (!mountedRef.current) {
        const entryMode = initialPickerModeRef.current;
        mountedRef.current = true;
        pickerModeRef.current = entryMode;
        setPickerMode(entryMode);
        pickerTransition.setValue(entryMode === 'yearMonth' ? 1 : 0);
        layoutHeight.setValue(entryPanelHeightRef.current);
        setMounted(true);
        setProgress(0);
      }
      animateTo(1);
      return;
    }
    if (!mountedRef.current) return;
    animateTo(0, () => {
      const entryMode = initialPickerModeRef.current;
      mountedRef.current = false;
      pickerModeRef.current = entryMode;
      setPickerMode(entryMode);
      pickerTransition.setValue(entryMode === 'yearMonth' ? 1 : 0);
      layoutHeight.setValue(entryPanelHeightRef.current);
      setMounted(false);
    });
  }, [animateTo, layoutHeight, pickerTransition, setProgress, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, visible]);

  const closeFromDrag = useCallback((dy: number) => {
    if (Math.abs(dy) <= DRAG_SLOP || dragDirection.current < 0) onClose();
    else animateTo(1);
  }, [animateTo, onClose]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => (
      pickerModeRef.current === 'date'
      && Math.abs(gesture.dy) > DRAG_SLOP
      && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    ),
    onPanResponderGrant: () => {
      previousDy.current = 0;
      dragDirection.current = 0;
      progress.stopAnimation(currentValue => {
        const current = typeof currentValue === 'number' ? currentValue : progressValue.current;
        progressValue.current = current;
        gestureStart.current = current;
      });
    },
    onPanResponderMove: (_, gesture) => {
      if (datePanelHeight <= 0) return;
      const delta = gesture.dy - previousDy.current;
      if (Math.abs(delta) > 0.5) dragDirection.current = delta < 0 ? -1 : 1;
      previousDy.current = gesture.dy;
      setProgress(gestureStart.current + gesture.dy / datePanelHeight);
    },
    onPanResponderRelease: (_, gesture) => closeFromDrag(gesture.dy),
    onPanResponderTerminate: () => closeFromDrag(previousDy.current),
  }), [closeFromDrag, datePanelHeight, progress, setProgress]);

  const handlePanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => (
      Math.abs(gesture.dy) > DRAG_SLOP && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    ),
    onPanResponderGrant: () => {
      previousDy.current = 0;
      dragDirection.current = 0;
    },
    onPanResponderMove: (_, gesture) => {
      const delta = gesture.dy - previousDy.current;
      if (Math.abs(delta) > 0.5) dragDirection.current = delta < 0 ? -1 : 1;
      previousDy.current = gesture.dy;
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy < -DRAG_SLOP) onClose();
    },
    onPanResponderTerminate: () => undefined,
  }), [onClose]);

  const togglePickerMode = () => {
    if (yearMonthOnly) return;
    const nextMode: PickerMode = pickerMode === 'date' ? 'yearMonth' : 'date';
    const target = nextMode === 'yearMonth' ? 1 : 0;
    pickerModeRef.current = nextMode;
    setPickerMode(nextMode);
    Animated.parallel([
      Animated.timing(pickerTransition, {
        toValue: target,
        duration: PICKER_TRANSITION_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
      Animated.timing(layoutHeight, {
        toValue: nextMode === 'yearMonth' ? yearMonthPanelHeight : datePanelHeight,
        duration: DATE_HEIGHT_ANIMATION_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
    ]).start();
  };

  if (!mounted) return null;

  const selectDate = (date: Date) => {
    if (date.getFullYear() !== month.getFullYear() || date.getMonth() !== month.getMonth()) {
      onMonthChange(startOfMonth(date));
    }
    onSelectDate(date);
  };

  const activePanelHeight = yearMonthOnly
    ? yearMonthOnlyPanelHeight
    : pickerMode === 'yearMonth' ? yearMonthPanelHeight : datePanelHeight;
  const panelTranslateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-activePanelHeight, 0],
  });

  return (
    <View
      style={s.overlay}
      pointerEvents="auto"
      accessibilityViewIsModal={visible}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
      testID="quick-date-overlay"
    >
      <Pressable
        style={s.dismissLayer}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={yearMonthOnly ? '关闭年月选择' : '关闭日期选择'}
        testID="quick-date-dismiss-layer"
      />
      <Animated.View
        style={[
          s.root,
          { top, height: entryPanelHeight },
          { height: layoutHeight },
        ]}
        {...panResponder.panHandlers}
        testID="quick-date-panel"
      >
        <Animated.View
          pointerEvents="none"
          style={[s.surface, { opacity: progress, transform: [{ translateY: panelTranslateY }] }]}
          testID="quick-date-panel-surface"
        />
        <Animated.View
          style={[s.contentShell, { transform: [{ translateY: panelTranslateY }] }]}
          testID="quick-date-panel-content-shell"
        >
          <View pointerEvents="none" style={s.contentBackground} />
          {!yearMonthOnly ? <View style={s.header}>
          <TouchableOpacity
            style={s.titleAction}
            onPress={togglePickerMode}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={pickerMode === 'date' ? '选择年月' : '返回日期选择'}
            accessibilityState={{ expanded: pickerMode === 'yearMonth' }}
            testID="quick-date-picker-toggle"
            hitSlop={10}
          >
            <Animated.Text style={[
              s.monthTitle,
              {
                color: pickerTransition.interpolate({
                  inputRange: [0, 1],
                  outputRange: [C.text, C.primary],
                }),
              },
            ]}>
              {formatMonthTitle(month)}
            </Animated.Text>
            <Animated.View style={[s.pickerArrow, {
              transform: [{
                rotate: pickerTransition.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '90deg'],
                }),
              }],
            }]}>
              <Ionicons name="chevron-forward" size={12} color={pickerMode === 'date' ? C.sub : C.primary} />
            </Animated.View>
          </TouchableOpacity>
          <Animated.View
            pointerEvents={pickerMode === 'date' ? 'auto' : 'none'}
            accessibilityElementsHidden={pickerMode !== 'date'}
            importantForAccessibility={pickerMode === 'date' ? 'auto' : 'no-hide-descendants'}
            style={[s.monthActions, {
              opacity: pickerTransition.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            }]}
          >
            <TouchableOpacity
              style={[s.arrowButton, s.previousMonthButton]}
              onPress={() => onMonthChange(addMonths(month, -1))}
              accessibilityRole="button"
              accessibilityLabel="上一个月"
              hitSlop={10}
            >
              <View style={s.monthArrowIcon}>
                <Ionicons name="chevron-back" size={14} color={C.sub} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.arrowButton, s.nextMonthButton]}
              onPress={() => onMonthChange(addMonths(month, 1))}
              accessibilityRole="button"
              accessibilityLabel="下一个月"
              hitSlop={10}
            >
              <View style={s.monthArrowIcon}>
                <Ionicons name="chevron-forward" size={14} color={C.sub} />
              </View>
            </TouchableOpacity>
          </Animated.View>
          </View> : null}

          {!yearMonthOnly ? <Animated.View
            pointerEvents={pickerMode === 'date' ? 'auto' : 'none'}
            accessibilityElementsHidden={pickerMode !== 'date'}
            importantForAccessibility={pickerMode === 'date' ? 'auto' : 'no-hide-descendants'}
            style={[s.dateContent, {
              height: dateContentHeight,
              opacity: pickerTransition.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            }]}
            testID="quick-date-date-content"
          >
            <View style={s.weekdayRow}>
              {WEEKDAYS.map(day => <Text key={day} style={s.weekday}>{day}</Text>)}
            </View>

            <QuickDateMonthPager
              month={month}
              selectedDate={selectedDate}
              today={today}
              events={events}
              onSelectDate={selectDate}
              onMonthChange={onMonthChange}
            />
          </Animated.View> : null}

          <Animated.View
            pointerEvents={pickerMode === 'yearMonth' ? 'auto' : 'none'}
            accessibilityElementsHidden={pickerMode !== 'yearMonth'}
            importantForAccessibility={pickerMode === 'yearMonth' ? 'auto' : 'no-hide-descendants'}
            style={[s.yearMonthContent, {
              top: yearMonthOnly ? 8 : HEADER_HEIGHT,
              opacity: pickerTransition,
            }]}
            testID="quick-date-year-month-content"
          >
            <YearMonthPicker month={month} onMonthChange={onMonthChange} />
          </Animated.View>

          <TouchableOpacity
            style={s.dragBar}
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={yearMonthOnly ? '收起年月选择' : '收起日期选择'}
            {...handlePanResponder.panHandlers}
          >
            <Ionicons name="chevron-up" size={18} color={C.border} />
          </TouchableOpacity>
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[s.topDivider, { opacity: progress }]}
          testID="quick-date-panel-top-divider"
        />
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 60,
  },
  dismissLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'transparent',
  },
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  contentShell: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  contentBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: SHADOW_BUFFER_HEIGHT,
    backgroundColor: C.body,
  },
  surface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: SHADOW_BUFFER_HEIGHT,
    backgroundColor: C.body,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  topDivider: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.divider,
  },
  header: {
    height: HEADER_HEIGHT,
    paddingTop: 16,
    paddingLeft: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  titleAction: { height: 22, flexDirection: 'row', alignItems: 'center', maxWidth: '60%' },
  monthTitle: { fontSize: 14, lineHeight: 22, fontWeight: '600' },
  pickerArrow: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  monthActions: { height: 22, flexDirection: 'row', alignItems: 'flex-start' },
  arrowButton: { height: 22, alignItems: 'flex-start', justifyContent: 'center' },
  previousMonthButton: { width: 61 },
  nextMonthButton: { width: 37 },
  monthArrowIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  dateContent: { position: 'absolute', top: HEADER_HEIGHT, left: 0, right: 0 },
  weekdayRow: { height: WEEKDAY_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, color: C.text },
  monthPagerViewport: { overflow: 'hidden' },
  monthPage: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: CELL_HEIGHT, alignItems: 'center' },
  dateCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  dateCircleToday: { backgroundColor: C.primary },
  dateCircleSelected: { backgroundColor: C.border },
  dateText: { fontSize: 16, lineHeight: 21, color: C.text },
  dateTextAdjacent: { color: C.disabled },
  dateTextToday: { color: C.primary },
  dateTextSelectedToday: { color: '#FFFFFF' },
  dateTextSelected: { color: C.faint },
  dotSlot: { position: 'absolute', top: 26, height: 4, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: C.primary },
  dotAdjacent: { backgroundColor: C.disabled },
  yearMonthContent: {
    position: 'absolute',
    top: HEADER_HEIGHT,
    left: 0,
    right: 0,
    height: YEAR_MONTH_CONTENT_HEIGHT,
    paddingVertical: 8,
    backgroundColor: C.body,
  },
  yearMonthPicker: { height: WHEEL_HEIGHT, flexDirection: 'row' },
  wheelColumn: { flex: 1, height: WHEEL_HEIGHT, overflow: 'hidden' },
  wheelContent: { paddingVertical: WHEEL_ITEM_HEIGHT * 2 },
  wheelItem: { height: WHEEL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  wheelText: { fontSize: 14, lineHeight: 22, color: C.faint },
  wheelTextSelected: { fontSize: 17, color: C.text, fontWeight: '400' },
  wheelTextNear: { color: C.sub },
  wheelTextFar: { color: C.disabled },
  wheelDivider: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  wheelDividerTop: { top: WHEEL_ITEM_HEIGHT * 2 },
  wheelDividerBottom: { top: WHEEL_ITEM_HEIGHT * 3 },
  dragBar: { position: 'absolute', left: 0, right: 0, bottom: SHADOW_BUFFER_HEIGHT, height: DRAG_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
