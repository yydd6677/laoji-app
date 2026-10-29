"""Bounded edits of one device-owned draft; no event persistence or free JSON paths."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


class EditModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScheduleTime(EditModel):
    precision: Literal["unspecified", "period", "exact"]
    period: Literal["early_morning", "morning", "noon", "afternoon", "evening", "night"] | None
    start_time: str | None
    end_time: str | None

    @model_validator(mode="after")
    def validate_time(self):
        import re
        if self.precision == "unspecified":
            valid = self.period is None and self.start_time is None and self.end_time is None
        elif self.precision == "period":
            valid = self.period is not None and self.start_time is None and self.end_time is None
        else:
            valid = (self.period is None and self.start_time is not None
                and re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", self.start_time) is not None
                and (self.end_time is None or re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", self.end_time) is not None))
        if not valid:
            raise ValueError("schedule_time_invalid")
        return self


class ScheduleDate(EditModel):
    start_date: str | None
    end_date: str | None

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_date(cls, value):
        if value is not None and date.fromisoformat(value).isoformat() != value:
            raise ValueError("schedule_date_invalid")
        return value


class ScheduleRecurrence(EditModel):
    repeat: Literal["once", "daily", "weekly", "monthly", "yearly"]
    interval: StrictInt = Field(ge=1, le=1000)
    weekdays: list[StrictInt] = Field(max_length=7)
    until_date: str | None

    @field_validator("weekdays")
    @classmethod
    def valid_weekdays(cls, value):
        if any(day < 1 or day > 7 for day in value) or len(set(value)) != len(value):
            raise ValueError("schedule_weekdays_invalid")
        return value

    @field_validator("until_date")
    @classmethod
    def valid_until(cls, value):
        return ScheduleDate.valid_date(value)


class ScheduleEditContent(ScheduleDate):
    title: str = Field(max_length=400)
    time: ScheduleTime
    location: str = Field(max_length=400)
    notes: str = Field(max_length=65536)
    category: Literal["工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他"]
    recurrence: ScheduleRecurrence
    reminder_minutes: StrictInt | None = Field(ge=0, le=525600)


class ScheduleEditRequest(EditModel):
    schema_version: Literal[1] = 1
    client_request_id: str = Field(min_length=8, max_length=180)
    draft_id: str = Field(min_length=1, max_length=180)
    base_revision: StrictInt = Field(ge=1)
    input_sequence: StrictInt = Field(ge=1)
    reference_datetime: datetime
    timezone: str = Field(min_length=1, max_length=64)
    mode: Literal["patch"]
    utterance: str = Field(min_length=1, max_length=2000)
    draft: ScheduleEditContent

    @field_validator("reference_datetime")
    @classmethod
    def aware_reference(cls, value):
        if value.utcoffset() is None:
            raise ValueError("schedule_reference_timezone_required")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("schedule_timezone_invalid") from error
        return value

    @field_validator("utterance")
    @classmethod
    def nonempty_utterance(cls, value):
        if not value.strip():
            raise ValueError("schedule_utterance_empty")
        return value


class ChangeBase(EditModel):
    op: Literal["set", "clear"]
    evidence: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def clear_has_no_value(self):
        if (self.op == "clear") != (self.value is None):
            raise ValueError("schedule_change_value_invalid")
        return self


class TextEdit(ChangeBase):
    value: str | None = Field(max_length=65536)


class DateEdit(ChangeBase):
    value: ScheduleDate | None


class TimeEdit(ChangeBase):
    value: ScheduleTime | None


class CategoryEdit(ChangeBase):
    value: Literal["工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他"] | None


class RecurrenceEdit(ChangeBase):
    value: ScheduleRecurrence | None


class ReminderEdit(ChangeBase):
    value: StrictInt | None = Field(ge=0, le=525600)


class TextChange(TextEdit):
    field: Literal["title", "location", "notes"]


class DateChange(DateEdit):
    field: Literal["date"]


class TimeChange(TimeEdit):
    field: Literal["time"]


class CategoryChange(CategoryEdit):
    field: Literal["category"]


class RecurrenceChange(RecurrenceEdit):
    field: Literal["recurrence"]


class ReminderChange(ReminderEdit):
    field: Literal["reminder"]


ScheduleChange = Annotated[TextChange | DateChange | TimeChange | CategoryChange | RecurrenceChange | ReminderChange,
    Field(discriminator="field")]


class ScheduleEditProposal(EditModel):
    status: Literal["patch", "no_change", "unsupported", "ambiguous"]
    changes: list[ScheduleChange] = Field(max_length=16)

    @model_validator(mode="after")
    def unique_fields(self):
        fields = [change.field for change in self.changes]
        if len(set(fields)) != len(fields) or (self.status == "patch") != bool(self.changes):
            raise ValueError("schedule_changes_invalid")
        return self


class TemporalSet(EditModel):
    """Keep one complete temporal expression together, including qualifiers."""
    op: Literal["set"]
    scope: Literal["start", "end", "range"]
    text: str = Field(min_length=1, max_length=2000)


class TemporalShift(EditModel):
    op: Literal["shift"]
    text: str = Field(min_length=1, max_length=2000)
    duration: str = Field(min_length=1, max_length=100)
    direction: Literal["later", "earlier"]


class TemporalClear(EditModel):
    op: Literal["clear_date", "clear_time", "clear_end"]
    text: str = Field(min_length=1, max_length=2000)


TemporalMentionEdit = Annotated[TemporalSet | TemporalShift | TemporalClear, Field(discriminator="op")]


class ScheduleEditModelObservation(EditModel):
    """One semantic observation; temporal spans are normalized locally.

    The model does not split a temporal expression into independent date/time
    fields or compute canonical dates, clocks, periods or numeric offsets.
    Empty temporal operations mean keep; clear_date is explicit uncertainty.
    """
    status: Literal["patch", "no_change", "unsupported", "ambiguous"]
    title: TextEdit | None
    temporal: list[TemporalMentionEdit] = Field(max_length=4)
    location: TextEdit | None
    notes: TextEdit | None
    category: CategoryEdit | None
    recurrence: RecurrenceEdit | None
    reminder: ReminderEdit | None

    @model_validator(mode="after")
    def status_matches_groups(self):
        populated = bool(self.temporal) or any(getattr(self, field) is not None for field in
            ("title", "location", "notes", "category", "recurrence", "reminder"))
        if (self.status == "patch") != populated:
            raise ValueError("schedule_observation_status_invalid")
        return self

    def proposal(self, *, date_edit: DateEdit | None = None, time_edit: TimeEdit | None = None) -> ScheduleEditProposal:
        return ScheduleEditProposal.model_validate({"status": self.status, "changes": [
            {"field": field, **value.model_dump()}
            for field in ("title", "date", "time", "location", "notes", "category", "recurrence", "reminder")
            if (value := date_edit if field == "date" else time_edit if field == "time" else getattr(self, field)) is not None]})


class ScheduleEditEvidence(EditModel):
    text: str
    # UTF-16 code units, matching JavaScript slice, not Python codepoint indices.
    start: int
    end: int


class ScheduleEditResponse(EditModel):
    schema_version: Literal[1] = 1
    draft_id: str
    base_revision: int
    input_sequence: int
    status: Literal["patch", "no_change", "unsupported", "ambiguous"]
    changes: list[ScheduleChange]
    evidence_spans: dict[str, ScheduleEditEvidence]
    producer_revision: str
